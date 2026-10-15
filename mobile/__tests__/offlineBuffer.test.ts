// Positions kept while the phone had no signal.

const mockRpc = jest.fn();

jest.mock('../src/supabase', () => ({
  supabase: { rpc: (...a: unknown[]) => mockRpc(...a) },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BATCH,
  bufferedCount,
  bufferPosition,
  flushBuffer,
  flushIfDue,
  MAX_BUFFERED,
  resetFlushClock,
  shouldBuffer,
} from '../src/offlineBuffer';
import type { PositionRow } from '../src/telemetry';

const row = (i: number, vehicle = 'veh-1'): PositionRow => ({
  vehicle_id: vehicle,
  lat: 28.6 + i * 0.0001,
  lng: 77.2,
  speed: 40,
  heading: 0,
  destination_lat: null,
  destination_lng: null,
  destination_name: null,
  alert_message: null,
  updated_at: new Date(Date.UTC(2026, 9, 16, 9, 0, i)).toISOString(),
});

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  resetFlushClock();
  mockRpc.mockResolvedValue({ data: 0, error: null });
});

describe('what is worth keeping', () => {
  it('keeps what failed for want of a network', () => {
    expect(shouldBuffer({ message: 'TypeError: Network request failed', code: '' })).toBe(true);
    expect(shouldBuffer({ message: 'JWT expired', code: 'PGRST301' })).toBe(true);
  });

  // These would be refused again; keeping them only fills the buffer.
  it('drops what the database refused for the data itself', () => {
    expect(shouldBuffer({ code: '23514' })).toBe(false); // check constraint
    expect(shouldBuffer({ code: '22003' })).toBe(false); // out of range
    expect(shouldBuffer({ code: '42501' })).toBe(false); // not permitted
  });

  it('keeps nothing when nothing failed', () => {
    expect(shouldBuffer(null)).toBe(false);
  });
});

describe('keeping', () => {
  it('keeps positions in order, as history needs them', async () => {
    await bufferPosition(row(1));
    await bufferPosition(row(2));
    expect(await bufferedCount('veh-1')).toBe(2);
  });

  it('survives the app restarting: it is in storage, not memory', async () => {
    await bufferPosition(row(1));
    const stored = JSON.parse((await AsyncStorage.getItem('sutra.offline.veh-1'))!);
    expect(stored[0]).toEqual({
      lat: row(1).lat,
      lng: 77.2,
      speed: 40,
      heading: 0,
      recorded_at: row(1).updated_at,
    });
  });

  it('keeps the newest when an outage outlasts the space', async () => {
    for (let i = 0; i < MAX_BUFFERED + 20; i++) await bufferPosition(row(i));
    const stored = JSON.parse((await AsyncStorage.getItem('sutra.offline.veh-1'))!);
    expect(stored).toHaveLength(MAX_BUFFERED);
    expect(stored[0].recorded_at).toBe(row(20).updated_at);
  });

  // The background task and the foreground watch can write at once.
  it('does not lose positions written at the same moment', async () => {
    await Promise.all(Array.from({ length: 30 }, (_, i) => bufferPosition(row(i))));
    expect(await bufferedCount('veh-1')).toBe(30);
  });

  it('keeps each vehicle apart', async () => {
    await bufferPosition(row(1, 'veh-1'));
    await bufferPosition(row(1, 'veh-2'));
    expect(await bufferedCount('veh-1')).toBe(1);
    expect(await bufferedCount('veh-2')).toBe(1);
  });
});

describe('sending', () => {
  it('sends oldest first, in batches, as history - never as a live position', async () => {
    for (let i = 0; i < BATCH + 50; i++) await bufferPosition(row(i));
    mockRpc.mockImplementation((_name, args) =>
      Promise.resolve({ data: args.p_points.length, error: null }),
    );

    expect(await flushBuffer('veh-1')).toBe(BATCH + 50);
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc.mock.calls[0][0]).toBe('record_buffered_positions');
    expect(mockRpc.mock.calls[0][1].p_points[0].recorded_at).toBe(row(0).updated_at);
    expect(mockRpc.mock.calls[0][1].p_points).toHaveLength(BATCH);
    expect(await bufferedCount('veh-1')).toBe(0);
  });

  it('keeps what it could not send for next time', async () => {
    for (let i = 0; i < 5; i++) await bufferPosition(row(i));
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Network request failed', code: '' } });
    expect(await flushBuffer('veh-1')).toBe(0);
    expect(await bufferedCount('veh-1')).toBe(5);
  });

  // Retrying something the server will always refuse would block everything
  // behind it forever.
  it('drops a batch the server will never accept', async () => {
    for (let i = 0; i < 5; i++) await bufferPosition(row(i));
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Not your vehicle.', code: '42501' } });
    await flushBuffer('veh-1');
    expect(await bufferedCount('veh-1')).toBe(0);
  });

  it('after a reconnect, sends at most every fifteen seconds', async () => {
    await bufferPosition(row(1));
    await flushIfDue('veh-1', 100_000);
    await bufferPosition(row(2));
    await flushIfDue('veh-1', 105_000);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    await flushIfDue('veh-1', 116_000);
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it('with nothing kept, sends nothing', async () => {
    await flushIfDue('veh-1', 100_000);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
