import { supabase } from './supabase';
import { distanceM, project, type Point } from './geo';

/**
 * The vehicles around the driver.
 *
 * Tesla reads the world with cameras and sees every object on the road. A
 * phone cannot. This is the connected-vehicle version instead: the SUTRA
 * vehicles nearby, drawn from positions they are already sharing. Different
 * mechanism, and it scales with how many people run the app rather than with
 * hardware.
 *
 * It polls rather than subscribes, because it has to. A driver may select only
 * their own position row, and Realtime delivers only rows the subscriber may
 * select, so a subscription would return their own vehicle and nothing else.
 * The database answers this through `nearby_vehicles`, which checks ownership
 * and strips every identifying field before anything leaves the server.
 */

export type Neighbour = {
  /** Opaque, per-caller. Never the vehicle id, plate or driver. */
  ref: string;
  lat: number;
  lng: number;
  /** km/h. */
  speed: number;
  /** Compass degrees. */
  heading: number;
  vehicle_type: string;
  is_emergency: boolean;
  /** Currently told to give way by a live green corridor. */
  warned: boolean;
};

/** A neighbour plus when we heard about it, which is what lets it be moved. */
export type TrackedNeighbour = Neighbour & { seenAt: number };

export const RADIUS_M = 400;

/**
 * How long a vehicle may be carried forward on its last known speed and
 * heading. Positions arrive every one to three seconds; without this the icons
 * would jump between updates and the view would look dead. Past this, the
 * guess is worth less than the honesty of letting it stop - a car that braked
 * or turned would otherwise sail on through a wall.
 */
export const MAX_EXTRAPOLATION_MS = 6_000;

export async function fetchNeighbours(
  vehicleId: string,
  radiusM: number = RADIUS_M,
): Promise<Neighbour[]> {
  const { data, error } = await supabase.rpc('nearby_vehicles', {
    p_vehicle_id: vehicleId,
    p_radius_m: radiusM,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as Neighbour[];
}

/** Where a vehicle has most likely got to since we last heard from it. */
export function reckon(neighbour: TrackedNeighbour, nowMs: number): Point {
  const here: Point = [neighbour.lat, neighbour.lng];
  const elapsed = Math.min(Math.max(nowMs - neighbour.seenAt, 0), MAX_EXTRAPOLATION_MS);
  const metres = (neighbour.speed / 3.6) * (elapsed / 1000);
  // Below a crawl the heading is noise, and a stationary car should sit still.
  if (metres < 1) return here;
  return project(here, neighbour.heading, metres);
}

/** How far this vehicle has been carried beyond its last real position. */
export function driftM(neighbour: TrackedNeighbour, nowMs: number): number {
  return distanceM([neighbour.lat, neighbour.lng], reckon(neighbour, nowMs));
}

/**
 * Keep one vehicle's surroundings up to date. Returns an unsubscribe function.
 *
 * Failures are reported but never stop the loop: a dropped request on a moving
 * phone is ordinary, and the next one is a second away.
 */
export function watchSurroundings(
  vehicleId: string,
  cadenceMs: number,
  onChange: (neighbours: TrackedNeighbour[]) => void,
  onError?: (message: string) => void,
): () => void {
  let stopped = false;
  let inFlight = false;

  const tick = async () => {
    // A slow answer must not queue another request behind it.
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const rows = await fetchNeighbours(vehicleId);
      if (stopped) return;
      const seenAt = Date.now();
      onChange(rows.map((row) => ({ ...row, seenAt })));
    } catch (e) {
      if (!stopped) onError?.((e as Error)?.message ?? 'Could not read nearby vehicles.');
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const timer = setInterval(tick, cadenceMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
