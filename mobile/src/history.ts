import { supabase } from './supabase';

/**
 * A driver's own trips and rule breaks.
 *
 * Trips are worked out by the database (vehicle_trips) from moving points only,
 * so time parked never counts as driving. Row-level security limits both
 * queries to the driver's own vehicles; nothing here restates that.
 */

export type Trip = {
  trip_no: number;
  started_at: string;
  ended_at: string;
  points: number;
  distance_m: number;
  top_speed: number;
  violations: number;
};

export type ViolationKind = 'SPEEDING' | 'HARSH_BRAKE' | 'WRONG_WAY';

export type Violation = {
  kind: ViolationKind;
  speed: number;
  speed_limit: number;
  lat: number;
  lng: number;
  occurred_at: string;
  cleared_at: string | null;
  /** What a speed and a limit cannot say: how hard, which road. */
  detail?: { from_kmh?: number; to_kmh?: number; seconds?: number; road?: string } | null;
};

export const HISTORY_DAYS = 7;

export async function fetchTrips(vehicleId: string, days = HISTORY_DAYS): Promise<Trip[]> {
  const { data, error } = await supabase.rpc('vehicle_trips', {
    p_vehicle_id: vehicleId,
    p_days: days,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as Trip[];
}

export async function fetchViolations(vehicleId: string, days = HISTORY_DAYS): Promise<Violation[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('violations')
    .select('kind, speed, speed_limit, lat, lng, occurred_at, cleared_at, detail')
    .eq('vehicle_id', vehicleId)
    .gte('occurred_at', since)
    .order('occurred_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as Violation[];
}

export function summarize(trips: Trip[]) {
  return {
    km: trips.reduce((m, t) => m + Number(t.distance_m), 0) / 1000,
    minutes: trips.reduce(
      (m, t) => m + (new Date(t.ended_at).getTime() - new Date(t.started_at).getTime()) / 60_000,
      0,
    ),
    topSpeed: trips.reduce((m, t) => Math.max(m, Number(t.top_speed) || 0), 0),
    ruleBreaks: trips.reduce((m, t) => m + (t.violations || 0), 0),
  };
}

export function formatDuration(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** What happened, in the words a driver would use. */
export function describeViolation(v: Violation): { title: string; detail: string } {
  if (v.kind === 'HARSH_BRAKE') {
    const d = v.detail ?? {};
    return {
      title: 'Harsh braking',
      detail:
        d.to_kmh !== undefined
          ? `From ${d.from_kmh} to ${d.to_kmh} km/h in ${d.seconds}s`
          : `Braked hard from ${Math.round(v.speed)} km/h`,
    };
  }
  if (v.kind === 'WRONG_WAY') {
    return {
      title: 'Wrong way',
      detail: `Against one-way ${v.detail?.road ?? 'road'} at ${Math.round(v.speed)} km/h`,
    };
  }

  const over = Math.round(v.speed - v.speed_limit);
  const seconds = v.cleared_at
    ? Math.max(1, Math.round((new Date(v.cleared_at).getTime() - new Date(v.occurred_at).getTime()) / 1000))
    : null;
  return {
    title: `Speeding · peak ${Math.round(v.speed)} km/h`,
    detail:
      `${over} km/h over the ${Math.round(v.speed_limit)} limit` +
      (seconds === null ? ', still going' : ` for ${seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`}`),
  };
}
