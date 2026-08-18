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
let activeDestination: Destination | null = null;
let activeAlert: string | null = null;

export function setDestination(destination: Destination | null): void {
  activeDestination = destination;
}

export function setAlertMessage(message: string | null): void {
  activeAlert = message;
}

// Defined at module scope so the background runtime can find it. Registering it
// inside a component would leave the task undefined when the OS relaunches the
// app into the background.
TaskManager.defineTask(TELEMETRY_TASK, async ({ data, error }: any) => {
  if (error || !activeVehicleId) return;

  const locations: Location.LocationObject[] | undefined = data?.locations;
  if (!locations?.length) return;

  const row = buildPositionRow(
    activeVehicleId,
    locations[locations.length - 1],
    activeDestination,
    activeAlert,
  );

  const { error: upsertError } = await supabase
    .from('vehicle_positions')
    .upsert(row, { onConflict: 'vehicle_id' });

  if (upsertError) {
    // Dropping the frame is correct: the next one is a second or three away,
    // and retrying would queue stale positions ahead of fresh ones.
    console.warn('[telemetry] upsert failed:', upsertError.message);
  }
});

export async function startTelemetry(vehicle: Vehicle): Promise<void> {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (foreground.status !== 'granted') {
    throw new Error('Location permission is required to stream telemetry.');
  }

  const background = await Location.requestBackgroundPermissionsAsync();
  if (background.status !== 'granted') {
    throw new Error('Background location is required to keep streaming while driving.');
  }

  activeVehicleId = vehicle.id;

  await Location.startLocationUpdatesAsync(TELEMETRY_TASK, {
    accuracy: vehicle.is_emergency_authorized
      ? Location.Accuracy.High
      : Location.Accuracy.Balanced,
    timeInterval: cadenceFor(vehicle.is_emergency_authorized),
    distanceInterval: 0,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'SUTRA Vehicle Client',
      notificationBody: 'Sharing your location with SUTRA traffic control.',
      notificationColor: '#0b6bcb',
    },
  });
}

export async function stopTelemetry(): Promise<void> {
  const running = await TaskManager.isTaskRegisteredAsync(TELEMETRY_TASK);
  if (running) await Location.stopLocationUpdatesAsync(TELEMETRY_TASK);

  activeVehicleId = null;
  activeDestination = null;
  activeAlert = null;
}
