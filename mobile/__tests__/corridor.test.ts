const mockInvoke = jest.fn();
const mockRpc = jest.fn();

jest.mock('../src/supabase', () => ({
  supabase: {
    functions: { invoke: (...a: unknown[]) => mockInvoke(...a) },
    rpc: (...a: unknown[]) => mockRpc(...a),
  },
}));

import {
  CorridorSignal,
  endCorridor,
  nextSignal,
  planCorridor,
  progressAlong,
  startCorridor,
} from '../src/corridor';

const ORIGIN = { latitude: 12.97, longitude: 77.59 };
const DEST = { latitude: 12.988, longitude: 77.59 };

// A straight 2 km road north, one point every ~24.9 m.
const ROUTE: [number, number][] = Array.from({ length: 81 }, (_, i) => [12.97 + i * 0.000225, 77.59]);

const PLAN = {
  route: ROUTE,
  distanceMeters: 1990,
  durationSeconds: 180,
  signals: [{ osm_id: 1, lat: 12.975, lng: 77.59 }],
  signalsAvailable: true,
};

const signal = (seq: number, along_m: number, state: CorridorSignal['state']): CorridorSignal => ({
  id: seq,
  seq,
  lat: 0,
  lng: 0,
  along_m,
  state,
});

beforeEach(() => jest.clearAllMocks());

describe('planCorridor', () => {
  it('asks the corridor function for a plan', async () => {
    mockInvoke.mockResolvedValue({ data: PLAN, error: null });
    await expect(planCorridor(ORIGIN, DEST)).resolves.toEqual(PLAN);
    expect(mockInvoke).toHaveBeenCalledWith('corridor', { body: { origin: ORIGIN, destination: DEST } });
  });

  it('surfaces a planning failure', async () => {
    mockInvoke.mockResolvedValue({ data: null, error: { message: 'Routing failed: NoRoute' } });
    await expect(planCorridor(ORIGIN, DEST)).rejects.toThrow(/NoRoute/);
  });

  // The server's signal lookup is blocked from cloud IPs; the phone is not.
  it('looks up junctions from the device when the server could not', async () => {
    mockInvoke.mockResolvedValue({ data: { ...PLAN, signals: [], signalsAvailable: false }, error: null });
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        elements: [
          { type: 'node', id: 10, lat: 12.975, lon: 77.59 },
          { type: 'node', id: 11, lat: 12.97505, lon: 77.59 }, // same crossroads
          { type: 'node', id: 20, lat: 12.98, lon: 77.59 },
        ],
      }),
    });

    const plan = await planCorridor(ORIGIN, DEST, fetchImpl as any);

    expect(plan.signalsAvailable).toBe(true);
    expect(plan.signals.map((s) => s.osm_id)).toEqual([10, 20]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('overpass');
    expect(init.headers.Accept).toBe('application/json');
    expect(init.headers['User-Agent']).toMatch(/^SUTRA-traffic\//);
    expect(decodeURIComponent(init.body)).toMatch(/\[highway=traffic_signals\]/);
  });

  it('does not repeat the lookup when the server already found junctions', async () => {
    mockInvoke.mockResolvedValue({ data: PLAN, error: null });
    const fetchImpl = jest.fn();
    await planCorridor(ORIGIN, DEST, fetchImpl as any);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Junctions are a nice-to-have; the ambulance still gets its corridor.
  it('keeps the corridor when the device lookup fails too', async () => {
    mockInvoke.mockResolvedValue({ data: { ...PLAN, signals: [], signalsAvailable: false }, error: null });
    const fetchImpl = jest.fn().mockRejectedValue(new Error('offline'));
    const plan = await planCorridor(ORIGIN, DEST, fetchImpl as any);
    expect(plan.signalsAvailable).toBe(false);
    expect(plan.route).toEqual(ROUTE);
  });

  it('refuses a plan with no usable route', async () => {
    mockInvoke.mockResolvedValue({ data: { ...PLAN, route: [] }, error: null });
    await expect(planCorridor(ORIGIN, DEST)).rejects.toThrow(/route/i);
  });
});

describe('startCorridor', () => {
  it('passes the plan to the start_corridor RPC', async () => {
    mockRpc.mockResolvedValue({ data: 'corridor-1', error: null });
    await expect(startCorridor('veh-1', 'City General Hospital', PLAN)).resolves.toBe('corridor-1');
    expect(mockRpc).toHaveBeenCalledWith('start_corridor', {
      p_vehicle_id: 'veh-1',
      p_destination_name: 'City General Hospital',
      p_route: ROUTE,
      p_signals: PLAN.signals,
      p_distance_m: 1990,
      p_duration_s: 180,
    });
  });

  it('explains a refusal from the database', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'This vehicle is not authorized to open a green corridor.' },
    });
    await expect(startCorridor('veh-1', 'x', PLAN)).rejects.toThrow(/not authorized/);
  });
});

describe('endCorridor', () => {
  it('calls the end_corridor RPC', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await endCorridor('corridor-1');
    expect(mockRpc).toHaveBeenCalledWith('end_corridor', { p_corridor_id: 'corridor-1' });
  });
});

describe('progressAlong', () => {
  it('is zero at the start of the route', () => {
    expect(progressAlong(ROUTE, { latitude: 12.97, longitude: 77.59 })).toBeCloseTo(0, 0);
  });

  it('measures distance travelled along the route', () => {
    // Point 40, slightly off the centre line: ~995 m along.
    const along = progressAlong(ROUTE, { latitude: 12.97 + 40 * 0.000225, longitude: 77.5903 });
    expect(Math.abs(along - 995)).toBeLessThan(15);
  });

  it('handles an empty route', () => {
    expect(progressAlong([], ORIGIN)).toBe(0);
  });
});

describe('nextSignal', () => {
  const signals = [signal(1, 600, 'PASSED'), signal(2, 1200, 'PREEMPT'), signal(3, 1800, 'WAITING')];

  it('is the first junction not yet passed, with its distance', () => {
    const next = nextSignal(signals, 900);
    expect(next?.signal.seq).toBe(2);
    expect(next?.distanceM).toBeCloseTo(300, 0);
  });

  it('never reports a negative distance', () => {
    expect(nextSignal(signals, 1250)?.distanceM).toBe(0);
  });

  it('is null once every junction is passed', () => {
    expect(nextSignal([signal(1, 600, 'PASSED')], 900)).toBeNull();
  });
});
