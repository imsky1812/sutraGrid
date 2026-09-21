import { cadenceFor, buildPositionRow } from '../src/telemetry';

const loc = (speed: number | null, heading: number | null) => ({
  coords: { latitude: 12.9716, longitude: 77.5946, speed, heading },
});

describe('cadenceFor', () => {
  it('uses 1s for an emergency-authorized vehicle', () => {
    expect(cadenceFor(true)).toBe(1000);
  });

  it('uses 3s otherwise, to spare the battery', () => {
    expect(cadenceFor(false)).toBe(3000);
  });
});

describe('buildPositionRow', () => {
  it('converts speed from m/s to km/h', () => {
    expect(buildPositionRow('veh-1', loc(10, 90), null, null).speed).toBeCloseTo(36, 5);
  });

  it('clamps a null speed or heading to zero', () => {
    const row = buildPositionRow('veh-1', loc(null, null), null, null);
    expect(row.speed).toBe(0);
    expect(row.heading).toBe(0);
  });

  // expo-location reports -1 for speed and heading when it has no fix yet.
  // Passing that through would violate the database check constraint and the
  // whole upsert would be rejected.
  it('clamps a negative speed reported before a fix', () => {
    const row = buildPositionRow('veh-1', loc(-1, -1), null, null);
    expect(row.speed).toBe(0);
    expect(row.heading).toBe(0);
  });

  it('never emits an emergency field for the server to trust', () => {
    const row = buildPositionRow('veh-1', loc(10, 90), null, 'CLEAR THE ROAD');
    expect(Object.keys(row).some((k) => /emergency/i.test(k))).toBe(false);
  });

  it('carries destination fields when a destination is set', () => {
    const row = buildPositionRow(
      'veh-1',
      loc(10, 90),
      { latitude: 12.98, longitude: 77.61, name: 'City General Hospital' },
      null,
    );
    expect(row.destination_lat).toBeCloseTo(12.98, 5);
    expect(row.destination_lng).toBeCloseTo(77.61, 5);
    expect(row.destination_name).toBe('City General Hospital');
  });

  it('nulls destination fields when there is no destination', () => {
    const row = buildPositionRow('veh-1', loc(10, 90), null, null);
    expect(row.destination_lat).toBeNull();
    expect(row.destination_lng).toBeNull();
    expect(row.destination_name).toBeNull();
  });

  it('passes the alert message through', () => {
    const row = buildPositionRow('veh-1', loc(10, 90), null, 'Yield lane');
    expect(row.alert_message).toBe('Yield lane');
  });

  it('truncates an over-long alert message to the column limit', () => {
    const row = buildPositionRow('veh-1', loc(10, 90), null, 'x'.repeat(500));
    expect(row.alert_message).toHaveLength(200);
  });

  it('stamps updated_at as an ISO timestamp', () => {
    const row = buildPositionRow('veh-1', loc(10, 90), null, null);
    expect(() => new Date(row.updated_at).toISOString()).not.toThrow();
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('uses the vehicle id it was given', () => {
    expect(buildPositionRow('veh-42', loc(10, 90), null, null).vehicle_id).toBe('veh-42');
  });
});

// Regression: requiring background permission before sending anything meant
// that on Android 11+, where it cannot be granted from a prompt, nothing was
// ever sent and the vehicle never appeared on the dashboard.
describe('startTelemetry permission handling', () => {
  const Location = require('expo-location');
  const { startTelemetry } = require('../src/telemetry');

  const vehicle = {
    id: 'veh-1',
    vehicle_number: 'KA-03-AB-1234',
    driver_name: 'A',
    vehicle_type: 'NORMAL',
    is_emergency_authorized: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    Location.getCurrentPositionAsync.mockResolvedValue({
      coords: { latitude: 12.97, longitude: 77.59, speed: 0, heading: 0 },
    });
    Location.watchPositionAsync.mockResolvedValue({ remove: jest.fn() });
    Location.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
  });

  it('streams in the foreground when background permission is refused', async () => {
    Location.requestBackgroundPermissionsAsync.mockResolvedValue({ status: 'denied' });

    await expect(startTelemetry(vehicle)).resolves.toBeUndefined();
    expect(Location.watchPositionAsync).toHaveBeenCalled();
  });

  it('does not start a background task when background permission is refused', async () => {
    Location.requestBackgroundPermissionsAsync.mockResolvedValue({ status: 'denied' });

    await startTelemetry(vehicle);
    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it('still refuses to stream without foreground permission', async () => {
    Location.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });

    await expect(startTelemetry(vehicle)).rejects.toThrow(/Location permission/i);
  });

  // Otherwise the operator sees nothing until the driver happens to move.
  it('sends one position immediately so the vehicle appears at once', async () => {
    Location.requestBackgroundPermissionsAsync.mockResolvedValue({ status: 'denied' });

    await startTelemetry(vehicle);
    expect(Location.getCurrentPositionAsync).toHaveBeenCalled();
  });
});
