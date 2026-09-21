import { PermissionsAndroid, Platform } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { supabase } from './supabase';
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
async function pushPosition(loc: Coords): Promise<void> {
  if (!activeVehicleId) return;

  const row = buildPositionRow(activeVehicleId, loc, activeDestination, activeAlert);
  const { error } = await supabase
    .from('vehicle_positions')
    .upsert(row, { onConflict: 'vehicle_id' });

  if (error) {
    // Dropping the frame is correct: the next one is a second or three away,
    // and retrying would queue stale positions ahead of fresh ones.
    console.warn('[telemetry] upsert rejected:', error.message);
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
  const interval = cadenceFor(vehicle.is_emergency_authorized);
  const accuracy = vehicle.is_emergency_authorized
    ? Location.Accuracy.High
    : Location.Accuracy.Balanced;

  // Send one position immediately so the vehicle appears on the dashboard the
  // moment a shift starts, rather than after the first movement.
  try {
    await pushPosition(await Location.getCurrentPositionAsync({ accuracy }));
  } catch (e) {
    console.warn('[telemetry] first fix failed:', (e as Error)?.message ?? e);
  }

  foregroundWatch?.remove();
  foregroundWatch = await Location.watchPositionAsync(
    { accuracy, timeInterval: interval, distanceInterval: 0 },
    (loc) => {
      void pushPosition(loc).catch(() => {});
    },
  );

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

    await Location.startLocationUpdatesAsync(TELEMETRY_TASK, {
      accuracy,
      timeInterval: interval,
      distanceInterval: 0,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'SUTRA Vehicle Client',
        notificationBody: 'Sharing your location with SUTRA traffic control.',
        notificationColor: '#D7F94A',
      },
    });
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
}
