// How often positions are sent, and how often the GPS is asked.

const mockUpsert = jest.fn();

jest.mock('../src/supabase', () => ({
  supabase: { from: () => ({ upsert: (...a: unknown[]) => mockUpsert(...a) }) },
}));
jest.mock('../src/offlineBuffer', () => ({
  ...jest.requireActual('../src/offlineBuffer'),
  bufferPosition: jest.fn().mockResolvedValue(undefined),
  flushIfDue: jest.fn().mockResolvedValue(undefined),
}));

import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import {
  __pushForTest as push,
  GPS_MOVING_MS,
  GPS_PARKED_MS,
  PARKED_AFTER_MS,
  sendIntervalFor,
  startTelemetry,
  stopTelemetry,
} from '../src/telemetry';

const car = {
  id: 'veh-1',
  vehicle_number: 'DL 01 AA 0001',
  driver_name: 'D',
  vehicle_type: 'NORMAL',
  is_emergency_authorized: false,
};
const ambulance = { ...car, vehicle_type: 'AMBULANCE', is_emergency_authorized: true };

/** A fix at `kmh`. */
const fix = (kmh: number) => ({
  coords: { latitude: 28.62, longitude: 77.43, speed: kmh / 3.6, heading: 0 },
});
/** Let the GPS-rate change, which runs in the background, finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const sent = () => mockUpsert.mock.calls.length;
const gpsRates = () =>
  (Location.watchPositionAsync as jest.Mock).mock.calls.map((c) => c[0].timeInterval);

let t0 = 0;

beforeEach(async () => {
  jest.clearAllMocks();
  mockUpsert.mockResolvedValue({ error: null });
  (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
  (Location.requestBackgroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'denied' });
  (Location.getCurrentPositionAsync as jest.Mock).mockResolvedValue(fix(0));
  (Location.watchPositionAsync as jest.Mock).mockResolvedValue({ remove: jest.fn() });
  await stopTelemetry();
});

const startAs = async (vehicle = car) => {
  await startTelemetry(vehicle);
  t0 = Date.now();
  mockUpsert.mockClear();
};

describe('how often a position is sent', () => {
  it('follows speed: parked, slow traffic, moving', () => {
    expect(sendIntervalFor(false, 0)).toBe(10_000);
    expect(sendIntervalFor(false, 12)).toBe(3000);
    expect(sendIntervalFor(false, 45)).toBe(1000);
  });

  it('is always every second for an emergency vehicle', () => {
    expect(sendIntervalFor(true, 0)).toBe(1000);
    expect(sendIntervalFor(true, 80)).toBe(1000);
  });

  it('a moving car sends every fix', async () => {
    await startAs();
    for (let i = 1; i <= 5; i++) await push(fix(60), t0 + i * 1000);
    expect(sent()).toBe(5);
  });

  it('in slow traffic, about one fix in three', async () => {
    await startAs();
    for (let i = 1; i <= 9; i++) await push(fix(12), t0 + i * 1000);
    expect(sent()).toBe(3);
  });

  it('when parked, once every ten seconds', async () => {
    await startAs();
    for (let i = 1; i <= 20; i++) await push(fix(0), t0 + i * 1000);
    expect(sent()).toBe(2);
  });

  // The foreground watch and the background task can deliver the same fix.
  it('never sends the same moment twice', async () => {
    await startAs();
    await push(fix(60), t0 + 1000);
    await push(fix(60), t0 + 1050);
    expect(sent()).toBe(1);
  });
});

describe('how often the GPS is asked', () => {
  it('starts at the full rate', async () => {
    await startAs();
    expect(gpsRates()).toEqual([GPS_MOVING_MS]);
  });

  // A red light is not parking.
  it('does not slow down for a short stop', async () => {
    await startAs();
    for (let i = 1; i <= 20; i++) await push(fix(0), t0 + i * 1000);
    await settle();
    expect(gpsRates()).toEqual([GPS_MOVING_MS]);
  });

  it('slows down once parked for half a minute, and speeds up on moving off', async () => {
    await startAs();
    await push(fix(0), t0 + 1000);
    await push(fix(0), t0 + 1000 + PARKED_AFTER_MS);
    await settle();
    expect(gpsRates()).toEqual([GPS_MOVING_MS, GPS_PARKED_MS]);

    await push(fix(30), t0 + 2000 + PARKED_AFTER_MS);
    await settle();
    expect(gpsRates()).toEqual([GPS_MOVING_MS, GPS_PARKED_MS, GPS_MOVING_MS]);
  });

  it('walking-pace jitter while parked does not wake it', async () => {
    await startAs();
    await push(fix(0), t0 + 1000);
    await push(fix(0), t0 + 1000 + PARKED_AFTER_MS);
    await settle();
    await push(fix(3), t0 + 5000 + PARKED_AFTER_MS);
    await settle();
    expect(gpsRates()).toEqual([GPS_MOVING_MS, GPS_PARKED_MS]);
  });

  it('never slows down for an emergency vehicle', async () => {
    await startAs(ambulance);
    await push(fix(0), t0 + 1000);
    await push(fix(0), t0 + 1000 + PARKED_AFTER_MS * 2);
    await settle();
    expect(gpsRates()).toEqual([GPS_MOVING_MS]);
  });

  describe('with background updates running', () => {
    beforeEach(() => {
      (Location.requestBackgroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
      (TaskManager.isTaskRegisteredAsync as jest.Mock).mockResolvedValue(false);
    });

    it('changes the background rate too', async () => {
      await startAs();
      await push(fix(0), t0 + 1000);
      await push(fix(0), t0 + 1000 + PARKED_AFTER_MS);
      await settle();
      const rates = (Location.startLocationUpdatesAsync as jest.Mock).mock.calls.map((c) => c[1].timeInterval);
      expect(rates).toEqual([GPS_MOVING_MS, GPS_PARKED_MS]);
    });

    // The fragile part. A failed restart must not leave the vehicle without
    // background updates.
    it('puts the old rate back if the new one will not start', async () => {
      await startAs();
      (Location.startLocationUpdatesAsync as jest.Mock)
        .mockRejectedValueOnce(new Error('service refused'))
        .mockResolvedValue(undefined);
      await push(fix(0), t0 + 1000);
      await push(fix(0), t0 + 1000 + PARKED_AFTER_MS);
      await settle();
      await settle();
      const rates = (Location.startLocationUpdatesAsync as jest.Mock).mock.calls.map((c) => c[1].timeInterval);
      expect(rates.slice(-2)).toEqual([GPS_PARKED_MS, GPS_MOVING_MS]);
    });
  });
});
