/**
 * Geometry shared by everything on the client.
 *
 * The planar approximation is deliberately the same one the database uses in
 * `approx_distance_m` and the Edge Functions use in their own `distanceM`, so
 * a distance never changes meaning depending on who measured it. It is good to
 * a fraction of a percent over the few kilometres any of this reasons about.
 */

export type Point = [number, number]; // [lat, lng]

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG = 111320;

export function distanceM(a: Point, b: Point): number {
  const dy = (b[0] - a[0]) * M_PER_DEG_LAT;
  const dx = (b[1] - a[1]) * M_PER_DEG_LNG * Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
  return Math.sqrt(dx * dx + dy * dy);
}
