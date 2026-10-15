// The vehicles around the driver, and the dead reckoning that makes them look
// alive between updates.

const mockRpc = jest.fn();

jest.mock('../src/supabase', () => ({
  supabase: { rpc: (...a: unknown[]) => mockRpc(...a) },
}));

import { distanceM } from '../src/geo';
import {
  driftM,
  fetchNeighbours,
  MAX_EXTRAPOLATION_MS,
  reckon,
  RADIUS_M,
  TrackedNeighbour,
  watchSurroundings,
} from '../src/surroundings';

const neighbour = (overrides: Partial<TrackedNeighbour> = {}): TrackedNeighbour => ({
  ref: 'abc123',
  lat: 28.6139,
  lng: 77.209,
  speed: 36, // 10 m/s
  heading: 0, // due north
  vehicle_type: 'NORMAL',
  is_emergency: false,
  warned: false,
  seenAt: 1_000_000,
  ...overrides,
});

beforeEach(() => jest.clearAllMocks());

describe('fetching', () => {
  test('asks the database, which is what strips the identities', async () => {
    mockRpc.mockResolvedValue({ data: [neighbour()], error: null });
    await fetchNeighbours('veh-1');
    expect(mockRpc).toHaveBeenCalledWith('nearby_vehicles', {
      p_vehicle_id: 'veh-1',
      p_radius_m: RADIUS_M,
    });
  });

  test('an empty answer is a list, not a null', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await expect(fetchNeighbours('veh-1')).resolves.toEqual([]);
  });

  test('a refusal is surfaced', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Not your vehicle.' } });
    await expect(fetchNeighbours('veh-9')).rejects.toThrow(/Not your vehicle/);
  });
});

// GPS arrives every one to three seconds. Without this the icons would jump.
describe('dead reckoning', () => {
  test('carries a vehicle forward along its heading', () => {
    const n = neighbour();
    const after2s = reckon(n, n.seenAt + 2000);
    expect(distanceM([n.lat, n.lng], after2s)).toBeCloseTo(20, 0);
    expect(after2s[0]).toBeGreaterThan(n.lat); // moved north
    expect(after2s[1]).toBeCloseTo(n.lng, 6);
  });

  test('follows the heading, not the map', () => {
    const n = neighbour({ heading: 90 });
    const [lat, lng] = reckon(n, n.seenAt + 1000);
    expect(lng).toBeGreaterThan(n.lng); // moved east
    expect(lat).toBeCloseTo(n.lat, 6);
  });

  test('a stationary vehicle stays put', () => {
    const n = neighbour({ speed: 0 });
    expect(reckon(n, n.seenAt + 5000)).toEqual([n.lat, n.lng]);
  });

  // A car that braked or turned would otherwise sail on through a wall.
  test('stops guessing once the position is too old', () => {
    const n = neighbour();
    const capped = reckon(n, n.seenAt + 60_000);
    const atLimit = reckon(n, n.seenAt + MAX_EXTRAPOLATION_MS);
    expect(capped).toEqual(atLimit);
    expect(driftM(n, n.seenAt + 60_000)).toBeCloseTo(60, 0);
  });

  test('never runs backwards if the clocks disagree', () => {
    const n = neighbour();
    expect(reckon(n, n.seenAt - 5000)).toEqual([n.lat, n.lng]);
  });
});

describe('watching', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('reports straight away and then on the cadence', async () => {
    mockRpc.mockResolvedValue({ data: [neighbour()], error: null });
    const onChange = jest.fn();
    const stop = watchSurroundings('veh-1', 1000, onChange);

    await jest.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0][0]).toHaveProperty('seenAt');

    await jest.advanceTimersByTimeAsync(2000);
    expect(onChange).toHaveBeenCalledTimes(3);
    stop();
  });

  test('stops when told to', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    const onChange = jest.fn();
    const stop = watchSurroundings('veh-1', 1000, onChange);
    await jest.advanceTimersByTimeAsync(0);
    stop();

    await jest.advanceTimersByTimeAsync(5000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // A dropped request on a moving phone is ordinary; the next one is a second
  // away, so it must not take the loop down with it.
  test('a failure is reported but the loop keeps going', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'network' } });
    mockRpc.mockResolvedValue({ data: [neighbour()], error: null });
    const onChange = jest.fn();
    const onError = jest.fn();

    const stop = watchSurroundings('veh-1', 1000, onChange, onError);
    await jest.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith('network');
    expect(onChange).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  test('a slow answer does not queue another request behind it', async () => {
    let release: (value: unknown) => void = () => {};
    mockRpc.mockReturnValueOnce(new Promise((r) => (release = r)));
    const stop = watchSurroundings('veh-1', 100, jest.fn());

    await jest.advanceTimersByTimeAsync(500);
    expect(mockRpc).toHaveBeenCalledTimes(1);

    release({ data: [], error: null });
    await jest.advanceTimersByTimeAsync(100);
    expect(mockRpc).toHaveBeenCalledTimes(2);
    stop();
  });
});
