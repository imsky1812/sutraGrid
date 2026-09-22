import { supabase } from './supabase';

/**
 * Green corridor client. The database decides who may open a corridor, which
 * drivers to warn, and what the (simulated) signals do. This module plans,
 * starts, ends and watches.
 */

export type SignalState = 'WAITING' | 'PREEMPT' | 'GREEN' | 'PASSED';

export type CorridorSignal = {
  id: number;
  seq: number;
  lat: number;
  lng: number;
  along_m: number;
  state: SignalState;
};

export type CorridorPlan = {
  /** [lat, lng] pairs, densified by the server. */
  route: [number, number][];
  distanceMeters: number | null;
  durationSeconds: number | null;
  signals: { osm_id: number; lat: number; lng: number }[];
  /** False when the junction lookup failed; the corridor still works. */
  signalsAvailable: boolean;
};

type Point = { latitude: number; longitude: number };

export const CORRIDOR_COLOR = '#22C55E';

/** Stoplight colours, so the state reads at a glance from across a cab. */
export const SIGNAL_COLOR: Record<SignalState, string> = {
  WAITING: '#FF6B5A',
  PREEMPT: '#F5B63B',
  GREEN: '#22C55E',
  PASSED: '#6B6F65',
};

export const SIGNAL_LABEL: Record<SignalState, string> = {
  WAITING: 'Red',
  PREEMPT: 'Clearing',
  GREEN: 'Green',
  PASSED: 'Passed',
};

export async function planCorridor(
  origin: Point,
  destination: Point,
  fetchImpl: typeof fetch = fetch,
): Promise<CorridorPlan> {
  const { data, error } = await supabase.functions.invoke('corridor', {
    body: { origin, destination },
  });
  if (error) throw new Error(error.message);
  if (!Array.isArray(data?.route) || data.route.length < 2) {
    throw new Error('No route returned for that destination.');
  }

  const plan = data as CorridorPlan;
  if (plan.signalsAvailable) return plan;

  // The public Overpass servers regularly refuse or time out the Edge
  // Function's requests (406, 504, 429 were all seen in testing) while serving
  // other callers. The phone is a second, independent chance at the junctions.
  const signals = await findSignalsFromDevice(plan.route, fetchImpl);
  return signals ? { ...plan, signals, signalsAvailable: true } : plan;
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_TIMEOUT_MS = 12_000;
/** Must match the server's radius, merge distance and query size. */
const SIGNAL_RADIUS_M = 25;
const JUNCTION_MERGE_M = 40;
const MAX_QUERY_POINTS = 120;
const MAX_SIGNALS = 200;

/** Traffic signals along the route from OpenStreetMap, or null on failure. */
export async function findSignalsFromDevice(
  route: [number, number][],
  fetchImpl: typeof fetch = fetch,
): Promise<CorridorPlan['signals'] | null> {
  const n = Math.min(MAX_QUERY_POINTS, route.length);
  const path = Array.from({ length: n }, (_, i) => route[Math.round((i * (route.length - 1)) / (n - 1))])
    .map(([lat, lng]) => `${lat.toFixed(6)},${lng.toFixed(6)}`)
    .join(',');
  const query = `[out:json][timeout:20];node(around:${SIGNAL_RADIUS_M},${path})[highway=traffic_signals];out;`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
    const response = await fetchImpl(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        // overpass-api.de answers 406 to generic library agents, and okhttp's
        // is what React Native's fetch sends on Android by default.
        'User-Agent': 'SUTRA-traffic/1.0 (green corridor planner)',
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!response.ok) return null;

    const data = (await response.json()) as {
      elements?: { type?: string; id?: number; lat?: number; lon?: number }[];
    };
    const nodes = (data.elements ?? [])
      .filter((e) => e.type === 'node' && typeof e.lat === 'number' && typeof e.lon === 'number')
      .map((e) => ({ osm_id: e.id as number, lat: e.lat as number, lng: e.lon as number }));

    // One per crossroads, in the order the vehicle meets them. The database
    // re-sorts by distance along the route, so order here is for display only.
    const junctions: CorridorPlan['signals'] = [];
    for (const s of nodes) {
      if (!junctions.some((j) => distanceM([j.lat, j.lng], [s.lat, s.lng]) <= JUNCTION_MERGE_M)) {
        junctions.push(s);
      }
    }
    return junctions.slice(0, MAX_SIGNALS);
  } catch {
    return null;
  }
}

export async function startCorridor(
  vehicleId: string,
  destinationName: string,
  plan: CorridorPlan,
): Promise<string> {
  const { data, error } = await supabase.rpc('start_corridor', {
    p_vehicle_id: vehicleId,
    p_destination_name: destinationName,
    p_route: plan.route,
    p_signals: plan.signals,
    p_distance_m: plan.distanceMeters,
    p_duration_s: plan.durationSeconds,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function endCorridor(corridorId: string): Promise<void> {
  const { error } = await supabase.rpc('end_corridor', { p_corridor_id: corridorId });
  if (error) throw new Error(error.message);
}

export async function fetchSignals(corridorId: string): Promise<CorridorSignal[]> {
  const { data, error } = await supabase
    .from('corridor_signals')
    .select('id, seq, lat, lng, along_m, state')
    .eq('corridor_id', corridorId)
    .order('seq');
  if (error) throw new Error(error.message);
  return (data ?? []) as CorridorSignal[];
}

/**
 * Follow one corridor: signal transitions, and the corridor ending (the
 * database ends it on arrival). Returns an unsubscribe function.
 */
export function watchCorridor(
  corridorId: string,
  onSignal: (signal: CorridorSignal) => void,
  onEnded: () => void,
): () => void {
  const channel = supabase
    .channel(`corridor-${corridorId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'corridor_signals',
        filter: `corridor_id=eq.${corridorId}`,
      },
      (payload) => onSignal(payload.new as CorridorSignal),
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'corridors', filter: `id=eq.${corridorId}` },
      (payload) => {
        if ((payload.new as { status?: string }).status === 'ENDED') onEnded();
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// Same planar approximation as the server, so client and database agree.
function distanceM(a: [number, number], b: [number, number]): number {
  const dy = (b[0] - a[0]) * 110540;
  const dx = (b[1] - a[1]) * 111320 * Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Metres travelled along the route, taken at its nearest point. */
export function progressAlong(route: [number, number][], here: Point): number {
  if (route.length === 0) return 0;
  const p: [number, number] = [here.latitude, here.longitude];
  let along = 0;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < route.length; i++) {
    if (i > 0) along += distanceM(route[i - 1], route[i]);
    const d = distanceM(route[i], p);
    if (d < bestD) [best, bestD] = [along, d];
  }
  return best;
}

/** The first junction still ahead, and how far away it is. */
export function nextSignal(
  signals: CorridorSignal[],
  progress: number,
): { signal: CorridorSignal; distanceM: number } | null {
  const signal = [...signals].sort((a, b) => a.seq - b.seq).find((s) => s.state !== 'PASSED');
  return signal ? { signal, distanceM: Math.max(0, signal.along_m - progress) } : null;
}
