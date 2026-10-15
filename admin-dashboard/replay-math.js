// Replay arithmetic, kept apart from the console so it can be tested without a
// browser. The console imports it; supabase/tests/replay.test.mjs tests it.

/** Where the vehicle was at time `t`, interpolated between the two fixes around it. */
export function positionAt(points, t) {
  if (t <= points[0].t) return points[0];
  const last = points[points.length - 1];
  if (t >= last.t) return last;

  // Binary search: a long trip is thousands of points and this runs every frame.
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lng: a.lng + (b.lng - a.lng) * f,
    speed: a.speed + (b.speed - a.speed) * f,
    heading: a.heading,
    t,
  };
}

export function formatDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
