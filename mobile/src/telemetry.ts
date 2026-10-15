import { PermissionsAndroid, Platform } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { supabase } from './supabase';
import { bufferPosition, flushIfDue, shouldBuffer } from './offlineBuffer';
import type { Vehicle } from './vehicles';

export const TELEMETRY_TASK = 'sutra-telemetry';

/** Matches the alert_message column limit; longer values would be rejected. */
const MAX_ALERT_LENGTH = 200;

export type Destination = { latitude: number; longitude: number; name: string };

export type PositionRow = {
  vehicle_id: string;
  lat: number;
  lng: number;
  speed: number;
  heading: number;
  destination_lat: number | null;
  destination_lng: number | null;
  destination_name: string | null;
  alert_message: string | null;
  updated_at: string;
};

/**
 * Emergency vehicles report every second, everyone else every three. This is
 * the battery trade-off carried over from the Kotlin client.
 */
export function cadenceFor(isEmergencyAuthorized: boolean): number {
  return isEmergencyAuthorized ? 1000 : 3000;
}

/**
 * How often a position is SENT, by how fast the vehicle is going.
 *
 * A phone's GPS produces about one fix a second, so 1 s is the floor: sending
 * more often would only repeat the same position. Above walking pace in
 * traffic, collision, zone and wrong-way checks are only as precise as the
 * gap between fixes - 50 m at 60 km/h when it was 3 s - so a moving vehicle
 * sends every fix. A parked one has nothing new to say.
 */
export const PARKED_KMH = 2;
export const SLOW_KMH = 20;

export function sendIntervalFor(isEmergencyAuthorized: boolean, speedKmh: number): number {
  if (isEmergencyAuthorized) return 1000;
  if (speedKmh < PARKED_KMH) return 10_000;
  if (speedKmh < SLOW_KMH) return 3000;
  return 1000;
}

/**
 * How often the GPS itself is asked for a fix. This is where the battery goes,
 * so a parked phone asks rarely. It changes only between parked and driving -
 * a few times a trip - because restarting location updates, the background
 * service especially, is the fragile part of this app; slow traffic is
 * handled by sending fewer of the 1 s fixes instead.
 */
export const GPS_MOVING_MS = 1000;
export const GPS_PARKED_MS = 10_000;
/** Stationary this long before the GPS slows down; a red light is not parking. */
export const PARKED_AFTER_MS = 30_000;
/** Moving again is noticed at the first fix above this. */
export const MOVING_KMH = 5;

type Coords = {
  coords: {
    latitude: number;
    longitude: number;
    speed: number | null;
    heading: number | null;
  };
};

export function buildPositionRow(
  vehicleId: string,
  loc: Coords,
  destination: Destination | null,
  alertMessage: string | null,
): PositionRow {
  return {
    vehicle_id: vehicleId,
    lat: loc.coords.latitude,
    lng: loc.coords.longitude,
    // expo-location reports m/s, and -1 when it has no fix yet. The database
    // rejects negatives, so an unclamped value would fail the whole upsert.
    speed: Math.max(0, (loc.coords.speed ?? 0) * 3.6),
    heading: Math.max(0, loc.coords.heading ?? 0),
    destination_lat: destination?.latitude ?? null,
    destination_lng: destination?.longitude ?? null,
    destination_name: destination?.name ?? null,
    alert_message: alertMessage ? alertMessage.slice(0, MAX_ALERT_LENGTH) : null,
    updated_at: new Date().toISOString(),
    // Deliberately no emergency field. The server derives that by joining to
    // vehicles.is_emergency_authorized, so there is nothing here to forge.
  };
}

// Module-level state: the background task runs outside React and cannot read
// component state.
let activeVehicleId: string | null = null;
let foregroundWatch: Location.LocationSubscription | null = null;
let activeDestination: Destination | null = null;
let activeAlert: string | null = null;

// Adaptive cadence.
let activeEmergency = false;
let activeAccuracy: Location.Accuracy = Location.Accuracy.Balanced;
let backgroundOn = false;
let lastSentAt = 0;
let parkedSince: number | null = null;
let gpsMode: 'moving' | 'parked' = 'moving';
let switchingGps = false;

export function setDestination(destination: Destination | null): void {
  activeDestination = destination;
}

export function setAlertMessage(message: string | null): void {
  activeAlert = message;
}

/**
 * Send one position. Shared by the foreground watch and the background task so
 * both produce identical rows.
 */
async function pushPosition(loc: Coords, now = Date.now()): Promise<void> {
  if (!activeVehicleId) return;

  const speedKmh = Math.max(0, (loc.coords.speed ?? 0) * 3.6);
  void adaptGps(speedKmh, now);

  // Not every fix needs sending. This also stops the double send when the
  // foreground watch and the background task both deliver the same fix.
  // A little slack, because location callbacks do not arrive on the dot.
  if (lastSentAt && now - lastSentAt < sendIntervalFor(activeEmergency, speedKmh) - 250) return;
  lastSentAt = now;

  const row = buildPositionRow(activeVehicleId, loc, activeDestination, activeAlert);
  const { error } = await supabase
    .from('vehicle_positions')
    .upsert(row, { onConflict: 'vehicle_id' });

  if (error) {
    // Never retried as a live position: the next one is a second or three
    // away, and replaying old fixes as live ones would move the vehicle
    // backwards on the map. But a fix lost to a dead zone is kept, and sent
    // later as history, so the track has no hole in it.
    if (shouldBuffer(error)) await bufferPosition(row);
    console.warn('[telemetry] upsert rejected:', error.message);
    return;
  }

  // Back online: send anything kept while there was no signal.
  void flushIfDue(row.vehicle_id);
}

function watchForeground(intervalMs: number): Promise<Location.LocationSubscription> {
  return Location.watchPositionAsync(
    { accuracy: activeAccuracy, timeInterval: intervalMs, distanceInterval: 0 },
    (loc) => {
      void pushPosition(loc).catch(() => {});
    },
  );
}

function startBackground(intervalMs: number): Promise<void> {
  return Location.startLocationUpdatesAsync(TELEMETRY_TASK, {
    accuracy: activeAccuracy,
    timeInterval: intervalMs,
    distanceInterval: 0,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'SUTRA Vehicle Client',
      notificationBody: 'Sharing your location with SUTRA traffic control.',
      notificationColor: '#D7F94A',
    },
  });
}

/**
 * Ask the GPS less often once parked, and normally again once moving.
 * Emergency vehicles always run at the full rate.
 */
async function adaptGps(speedKmh: number, now: number): Promise<void> {
  if (activeEmergency || switchingGps || !activeVehicleId) return;

  if (speedKmh < PARKED_KMH) parkedSince ??= now;
  else parkedSince = null;

  const want =
    parkedSince !== null && now - parkedSince >= PARKED_AFTER_MS
      ? 'parked'
      : speedKmh >= MOVING_KMH
        ? 'moving'
        : gpsMode;
  if (want === gpsMode) return;

  switchingGps = true;
  const interval = want === 'parked' ? GPS_PARKED_MS : GPS_MOVING_MS;
  const previous = want === 'parked' ? GPS_MOVING_MS : GPS_PARKED_MS;
  try {
    foregroundWatch?.remove();
    foregroundWatch = await watchForeground(interval);

    if (backgroundOn) {
      try {
        try {
          await Location.stopLocationUpdatesAsync(TELEMETRY_TASK);
        } catch {
          // Already stopped is fine; starting again is what matters.
        }
        await startBackground(interval);
      } catch (e) {
        // Never leave the vehicle without background updates over a change of
        // rate: put the old one back.
        console.warn('[telemetry] could not change background rate:', (e as Error)?.message ?? e);
        await startBackground(previous).catch(() => {});
      }
    }
    gpsMode = want;
  } catch (e) {
    console.warn('[telemetry] could not change GPS rate:', (e as Error)?.message ?? e);
  } finally {
    switchingGps = false;
  }
}

// Defined at module scope so the background runtime can find it. Registering it
// inside a component would leave the task undefined when the OS relaunches the
// app into the background.
TaskManager.defineTask(TELEMETRY_TASK, async ({ data, error }: any) => {
  // This runs in the background, outside any React error boundary. An
  // unhandled rejection here takes the whole app down, which is what made the
  // app die after running for a while, so nothing is allowed to escape.
  try {
    if (error || !activeVehicleId) return;

    const locations: Location.LocationObject[] | undefined = data?.locations;
    if (!locations?.length) return;

    await pushPosition(locations[locations.length - 1]);
  } catch (e) {
    // Losing connectivity, a refreshing token, a malformed frame: all survivable.
    console.warn('[telemetry] frame dropped:', (e as Error)?.message ?? e);
  }
});

/**
 * Android 13 and later require notification permission at runtime. Declaring it
 * in the manifest is not enough.
 *
 * This matters more than it looks: the location updates run as a foreground
 * service, and a foreground service must show a persistent notification. If the
 * permission was never granted the notification cannot be posted, Android tears
 * the service down, and the app goes with it - which is exactly what "the app
 * closes itself" looks like from the outside.
 */
async function ensureNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || typeof Platform.Version !== 'number') return true;
  if (Platform.Version < 33) return true;

  try {
    const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    if (!permission) return true;

    if (await PermissionsAndroid.check(permission)) return true;
    const result = await PermissionsAndroid.request(permission);
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch (e) {
    // Never block streaming on the permission check itself failing.
    console.warn('[telemetry] notification permission check failed:', (e as Error)?.message ?? e);
    return false;
  }
}

/**
 * Begin streaming this vehicle's position.
 *
 * Foreground streaming starts as soon as location permission is granted, and is
 * what makes the vehicle appear on the operator's map. Background streaming is
 * an upgrade layered on top.
 *
 * That split matters. Android 11 and later will not grant background location
 * from a prompt - the driver has to open Settings and choose "Allow all the
 * time" - so requiring it before sending anything meant that for most people
 * nothing was ever sent and the dashboard stayed empty. A refused background
 * permission now costs only updates while the app is not on screen.
 */
export async function startTelemetry(vehicle: Vehicle): Promise<void> {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (foreground.status !== 'granted') {
    throw new Error('Location permission is required to stream telemetry.');
  }

  activeVehicleId = vehicle.id;
  activeEmergency = vehicle.is_emergency_authorized;
  activeAccuracy = vehicle.is_emergency_authorized
    ? Location.Accuracy.High
    : Location.Accuracy.Balanced;
  const accuracy = activeAccuracy;
  // Start at the full rate; a vehicle that turns out to be parked slows down
  // after half a minute.
  gpsMode = 'moving';
  parkedSince = null;
  lastSentAt = 0;
  backgroundOn = false;

  // Send one position immediately so the vehicle appears on the dashboard the
  // moment a shift starts, rather than after the first movement.
  try {
    await pushPosition(await Location.getCurrentPositionAsync({ accuracy }));
  } catch (e) {
    console.warn('[telemetry] first fix failed:', (e as Error)?.message ?? e);
  }

  foregroundWatch?.remove();
  foregroundWatch = await watchForeground(GPS_MOVING_MS);

  // Everything past here is the background upgrade, and none of it is allowed
  // to stop foreground streaming that is already working.
  try {
    const background = await Location.requestBackgroundPermissionsAsync();
    if (background.status !== 'granted') {
      console.warn('[telemetry] background location refused; foreground streaming only.');
      return;
    }

    const canNotify = await ensureNotificationPermission();
    if (!canNotify) {
      // A foreground service whose notification is blocked gets killed by
      // Android, taking the app with it. Not worth the background updates.
      console.warn('[telemetry] notifications refused; foreground streaming only.');
      return;
    }

    // Starting a task that is already registered throws on some devices, and
    // navigating between screens can call this twice.
    if (await TaskManager.isTaskRegisteredAsync(TELEMETRY_TASK)) {
      await Location.stopLocationUpdatesAsync(TELEMETRY_TASK).catch(() => {});
    }

    await startBackground(GPS_MOVING_MS);
    backgroundOn = true;
  } catch (e) {
    console.warn('[telemetry] background streaming unavailable:', (e as Error)?.message ?? e);
  }
}

export async function stopTelemetry(): Promise<void> {
  foregroundWatch?.remove();
  foregroundWatch = null;

  try {
    const running = await TaskManager.isTaskRegisteredAsync(TELEMETRY_TASK);
    if (running) await Location.stopLocationUpdatesAsync(TELEMETRY_TASK);
  } catch (e) {
    // Called from unmount cleanup, where throwing would be worse than failing.
    console.warn('[telemetry] stop failed:', (e as Error)?.message ?? e);
  }

  activeVehicleId = null;
  activeDestination = null;
  activeAlert = null;
  backgroundOn = false;
  lastSentAt = 0;
  parkedSince = null;
  gpsMode = 'moving';
}

/** For tests: send one fix as if it had come from the GPS at time `now`. */
export const __pushForTest = pushPosition;
