/**
 * Geometry shared by everything on the client.
 *
 * The planar approximation is deliberately the same one the database uses in
 * `approx_distance_m` and the Edge Functions use in their own `distanceM`, so
 * a distance never changes meaning depending on who measured it. It is good to
 * a fraction of a percent over the few kilometres any of this reasons about.
 */

export type Point = [number, number]; // [lat, lng]
export type LatLng = { latitude: number; longitude: number };

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG = 111320;
const RAD = Math.PI / 180;

export function distanceM(a: Point, b: Point): number {
  const dy = (b[0] - a[0]) * M_PER_DEG_LAT;
  const dx = (b[1] - a[1]) * M_PER_DEG_LNG * Math.cos((((a[0] + b[0]) / 2) * RAD));
  return Math.sqrt(dx * dx + dy * dy);
}

/** Fold any angle into 0–360, so -90 and 270 are the same heading. */
export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Compass bearing from `a` to `b`: 0 is north, 90 is east. */
export function bearing(a: Point, b: Point): number {
  const dy = (b[0] - a[0]) * M_PER_DEG_LAT;
  const dx = (b[1] - a[1]) * M_PER_DEG_LNG * Math.cos((((a[0] + b[0]) / 2) * RAD));
  if (dx === 0 && dy === 0) return 0;
  return normalizeDeg(Math.atan2(dx, dy) / RAD);
}

/** Move `from` this far along a compass bearing. The inverse of `bearing`. */
export function project(from: Point, bearingDeg: number, metres: number): Point {
  const theta = normalizeDeg(bearingDeg) * RAD;
  const dy = Math.cos(theta) * metres;
  const dx = Math.sin(theta) * metres;
  return [
    from[0] + dy / M_PER_DEG_LAT,
    from[1] + dx / (M_PER_DEG_LNG * Math.cos(from[0] * RAD)),
  ];
}

/**
 * Where something is from the driver's point of view: how far, and how many
 * degrees off their own nose. 0 is straight ahead, 90 is to their right.
 *
 * This is what the radar needs. A map shows compass bearings; a driver-centred
 * view shows relative ones, which is why they are computed here and not left to
 * the component.
 */
export function toRelative(
  ego: Point,
  egoHeadingDeg: number,
  other: Point,
): { bearingDeg: number; distanceM: number } {
  return {
    bearingDeg: normalizeDeg(bearing(ego, other) - egoHeadingDeg),
    distanceM: distanceM(ego, other),
  };
}

/**
 * The direction a vehicle is actually facing.
 *
 * A phone's GPS heading is 0 while it is stationary and unreliable at walking
 * pace, so below that the previous fix is a better source: the way it came is
 * the way it is pointing. Falls back to the last known heading rather than
 * snapping an icon to north.
 */
export function headingFrom(
  reported: number | null | undefined,
  speedKmh: number,
  previous: Point | null,
  current: Point,
  lastKnown = 0,
): number {
  if (speedKmh >= 2 && typeof reported === 'number' && reported > 0) {
    return normalizeDeg(reported);
  }
  if (previous && distanceM(previous, current) >= 5) return bearing(previous, current);
  return normalizeDeg(lastKnown);
}
