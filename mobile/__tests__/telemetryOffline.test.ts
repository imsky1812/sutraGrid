// What telemetry does when a live position does not get through.

const mockUpsert = jest.fn();
const mockBuffer = jest.fn();
const mockFlush = jest.fn();

jest.mock('../src/supabase', () => ({
  supabase: { from: () => ({ upsert: (...a: unknown[]) => mockUpsert(...a) }) },
}));

jest.mock('../src/offlineBuffer', () => ({
  ...jest.requireActual('../src/offlineBuffer'),
  bufferPosition: (...a: unknown[]) => mockBuffer(...a),
  flushIfDue: (...a: unknown[]) => mockFlush(...a),
}));

import * as Location from 'expo-location';
import { startTelemetry } from '../src/telemetry';

const vehicle = {
  id: 'veh-1',
  vehicle_number: 'KA-03-AB-1234',
  driver_name: 'A',
  vehicle_type: 'NORMAL',
  is_emergency_authorized: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
  (Location.requestBackgroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'denied' });
  (Location.getCurrentPositionAsync as jest.Mock).mockResolvedValue({
    coords: { latitude: 28.62, longitude: 77.43, speed: 10, heading: 90 },
  });
  (Location.watchPositionAsync as jest.Mock).mockResolvedValue({ remove: jest.fn() });
  mockBuffer.mockResolvedValue(undefined);
  mockFlush.mockResolvedValue(undefined);
});

// The first fix is sent the moment a shift starts, so it is the easy one to
// observe; every later fix goes through the same path.
it('keeps a position that failed for want of a network', async () => {
  mockUpsert.mockResolvedValue({ error: { message: 'Network request failed', code: '' } });
  await startTelemetry(vehicle);
  expect(mockBuffer).toHaveBeenCalledWith(expect.objectContaining({ vehicle_id: 'veh-1', lat: 28.62 }));
  expect(mockFlush).not.toHaveBeenCalled();
});

it('does not keep one the database refused for its content', async () => {
  mockUpsert.mockResolvedValue({ error: { message: 'violates check constraint', code: '23514' } });
  await startTelemetry(vehicle);
  expect(mockBuffer).not.toHaveBeenCalled();
});

it('once a live position gets through, sends what was kept', async () => {
  mockUpsert.mockResolvedValue({ error: null });
  await startTelemetry(vehicle);
  expect(mockFlush).toHaveBeenCalledWith('veh-1');
  expect(mockBuffer).not.toHaveBeenCalled();
});
