/**
 * The arithmetic behind the fleet simulator.
 *
 * Kept free of network calls and of the Supabase client so it can be tested
 * directly: a simulator that lies about where a vehicle is would quietly
 * invalidate every demo run on top of it.
 */

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG = 111320;
const RAD = Math.PI / 180;

/** The same planar approximation the database and the app use. */
export function distanceM(a, b) {
  const dy = (b[0] - a[0]) * M_PER_DEG_LAT;
  const dx = (b[1] - a[1]) * M_PER_DEG_LNG * Math.cos(((a[0] + b[0]) / 2) * RAD);
  return Math.sqrt(dx * dx + dy * dy);
}

export function bearing(a, b) {
  const dy = (b[0] - a[0]) * M_PER_DEG_LAT;
  const dx = (b[1] - a[1]) * M_PER_DEG_LNG * Math.cos(((a[0] + b[0]) / 2) * RAD);
  if (dx === 0 && dy === 0) return 0;
  return ((Math.atan2(dx, dy) / RAD) % 360 + 360) % 360;
}

export function project(from, bearingDeg, metres) {
  const theta = bearingDeg * RAD;
  return [
    from[0] + (Math.cos(theta) * metres) / M_PER_DEG_LAT,
    from[1] + (Math.sin(theta) * metres) / (M_PER_DEG_LNG * Math.cos(from[0] * RAD)),
  ];
}

/** Cumulative distance to each point, so a position along the route is a lookup. */
export function measure(route) {
  const along = [0];
  for (let i = 1; i < route.length; i++) along.push(along[i - 1] + distanceM(route[i - 1], route[i]));
  return along;
}

/**
 * Where a vehicle is after travelling `metres` along the route, and which way
 * it is pointing. Returns `done` once it runs off the end, which is the cue to
 * pick a new destination rather than to stop reporting.
 */
export function positionAlong(route, along, metres) {
  const total = along[along.length - 1];
  if (route.length < 2) return { point: route[0] ?? [0, 0], heading: 0, done: true };
  if (metres >= total) {
    return { point: route[route.length - 1], heading: bearing(route[route.length - 2], route[route.length - 1]), done: true };
  }

  let i = 1;
  while (i < along.length - 1 && along[i] < metres) i++;
  const segment = along[i] - along[i - 1];
  const t = segment > 0 ? (metres - along[i - 1]) / segment : 0;
  const a = route[i - 1];
  const b = route[i];

  return {
    point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    heading: bearing(a, b),
    done: false,
  };
}

/** Ordinary braking and acceleration, in m/s². Harder braking is a violation. */
export const MAX_DECEL = 2.5;
export const MAX_ACCEL = 1.5;

/**
 * Traffic does not move at a constant speed, and a constant one makes a demo
 * look fake. This wanders around the target without ever going backwards, and
 * now and then slows toward a crawl as though for a junction.
 *
 * It changes speed only as fast as an ordinary driver would. An earlier
 * version dropped to a crawl in a single step - 38 to 4 km/h in two seconds -
 * and the harsh-braking check rightly flagged four of five simulated cars in
 * their first minute.
 */
export function nextSpeed(current, target, random = Math.random, seconds = 2) {
  const roll = random();
  let wanted;
  // Roughly one update in twenty-five begins a hold-up.
  if (roll < 0.04) wanted = Math.max(0, target * 0.1);
  else {
    const drift = (roll - 0.5) * target * 0.25;
    wanted = Math.min(target * 1.15, Math.max(0, current * 0.7 + (target + drift) * 0.3));
  }
  const maxDrop = MAX_DECEL * 3.6 * seconds;
  const maxRise = MAX_ACCEL * 3.6 * seconds;
  return Math.max(0, Math.min(current + maxRise, Math.max(current - maxDrop, wanted)));
}

/** A point to drive to: somewhere in a ring around the centre, not on top of it. */
export function pickDestination(centre, radiusM, random = Math.random) {
  const bearingDeg = random() * 360;
  const distance = radiusM * (0.5 + random() * 0.5);
  return project(centre, bearingDeg, distance);
}

/** Plates that are obviously not real vehicles, and sort together in the console. */
export function plateFor(index) {
  return `SIM ${String(index + 1).padStart(4, '0')}`;
}

export const SIM_PLATE_PREFIX = 'SIM ';

/**
 * One simulated vehicle's state machine. `advance` is called once per tick and
 * returns the row to upsert, or null while it is waiting for a new route.
 */
export function createDriver({ id, plate, targetKmh, random = Math.random }) {
  let route = null;
  let along = null;
  let travelled = 0;
  let speed = targetKmh;

  return {
    id,
    plate,
    targetKmh,
    /** True when the driver needs a new route before it can move again. */
    get needsRoute() {
      return route === null;
    },
    setRoute(points) {
      route = points;
      along = measure(points);
      travelled = 0;
    },
    advance(elapsedSeconds) {
      if (!route) return null;

      speed = nextSpeed(speed, targetKmh, random, elapsedSeconds);
      travelled += (speed / 3.6) * elapsedSeconds;
      const { point, heading, done } = positionAlong(route, along, travelled);
      if (done) route = null;

      return { lat: point[0], lng: point[1], speed, heading };
    },
  };
}
