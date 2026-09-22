// Request handler for the green-corridor Edge Function.
//
// Plans a corridor: the fastest route from OSRM, densified so the database can
// measure "how far is this car from the route" meaningfully, plus the real
// traffic signals along it from OpenStreetMap. The app passes the result to
// the start_corridor RPC, which is where authorization is enforced.
//
// Like the other functions, this file has no Deno globals so it can be unit
// tested under Node; index.ts is the wiring.

export type LatLng = { latitude: number; longitude: number };
export type Signal = { osm_id: number; lat: number; lng: number };

export type Deps = {
  routerUrl: string;
  /** Tried in order; the public servers are often busy. */
  overpassUrls: string[];
  userAgent: string;
  fetchImpl: typeof fetch;
};

export const DEFAULT_ROUTER = 'https://router.project-osrm.org';
export const DEFAULT_OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
/** Per server. The ambulance is waiting on this, so give up quickly. */
const OVERPASS_TIMEOUT_MS = 12_000;
export const DEFAULT_USER_AGENT = 'SUTRA-traffic/1.0 (green corridor planner)';

/** Densify spacing. Matches the 150 m warning radius with a wide margin. */
export const SPACING_M = 25;
/** The start_corridor RPC refuses routes longer than this. */
export const MAX_POINTS = 5000;
/** Signal nodes this close together belong to the same junction. */
export const JUNCTION_MERGE_M = 40;
/** How far from the route a signal may be and still count as on it. */
export const SIGNAL_RADIUS_M = 25;
export const MAX_SIGNALS = 200;
/** Keeps the Overpass query small; the path is only used as a search corridor. */
const MAX_QUERY_POINTS = 120;

type Point = [number, number]; // [lat, lng]

/** Same planar approximation the database uses, so both agree on distances. */
export function distanceM(a: Point, b: Point): number {
  const dy = (b[0] - a[0]) * 110540;
  const dx = (b[1] - a[1]) * 111320 * Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
  return Math.sqrt(dx * dx + dy * dy);
}

export function routeLength(route: Point[]): number {
  let total = 0;
  for (let i = 1; i < route.length; i++) total += distanceM(route[i - 1], route[i]);
  return total;
}

/**
 * Insert points so no two neighbours are more than `spacing` apart. OSRM
 * returns only the bends, so a long straight road can be a single segment, and
 * a car halfway along it would look far from the route.
 */
export function densify(route: Point[], spacing: number): Point[] {
  if (route.length < 2) return route.slice();
  const out: Point[] = [route[0]];
  for (let i = 1; i < route.length; i++) {
    const [a, b] = [route[i - 1], route[i]];
    const pieces = Math.max(1, Math.ceil(distanceM(a, b) / spacing));
    for (let k = 1; k <= pieces; k++) {
      const t = k / pieces;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Evenly pick at most `max` points, always keeping both ends. */
export function samplePath(route: Point[], max: number): Point[] {
  if (route.length <= max) return route.slice();
  const out: Point[] = [];
  for (let i = 0; i < max; i++) out.push(route[Math.round((i * (route.length - 1)) / (max - 1))]);
  return out;
}

/**
 * OpenStreetMap maps each signal head or stop line as its own node, so one
 * crossroads is often three or four nodes. Collapse them to one per junction.
 */
export function mergeJunctions(signals: Signal[], radius: number): Signal[] {
  const kept: Signal[] = [];
  for (const s of signals) {
    if (!kept.some((k) => distanceM([k.lat, k.lng], [s.lat, s.lng]) <= radius)) kept.push(s);
  }
  return kept;
}

/** Order signals by where the vehicle meets them, nearest route point first. */
export function orderAlongRoute(signals: Signal[], route: Point[]): Signal[] {
  const index = (s: Signal) => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < route.length; i++) {
      const d = distanceM(route[i], [s.lat, s.lng]);
      if (d < bestD) [best, bestD] = [i, d];
    }
    return best;
  };
  return signals
    .map((s) => ({ s, i: index(s) }))
    .sort((a, b) => a.i - b.i)
    .map(({ s }) => s);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isLatLng(value: unknown): value is LatLng {
  const p = value as LatLng | null;
  return (
    !!p &&
    typeof p === 'object' &&
    typeof p.latitude === 'number' &&
    Number.isFinite(p.latitude) &&
    p.latitude >= -90 &&
    p.latitude <= 90 &&
    typeof p.longitude === 'number' &&
    Number.isFinite(p.longitude) &&
    p.longitude >= -180 &&
    p.longitude <= 180
  );
}

/**
 * Signals along the route, or null if the lookup failed. A failure is not
 * fatal: the corridor still routes and still warns drivers, it just has no
 * junctions to show.
 */
async function findSignals(route: Point[], deps: Deps): Promise<Signal[] | null> {
  const path = samplePath(route, MAX_QUERY_POINTS)
    .map(([lat, lng]) => `${lat.toFixed(6)},${lng.toFixed(6)}`)
    .join(',');
  const query = `[out:json][timeout:20];node(around:${SIGNAL_RADIUS_M},${path})[highway=traffic_signals];out;`;

  for (const url of deps.overpassUrls) {
    try {
      const response = await deps.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // overpass-api.de answers 406 to requests that do not ask for JSON.
          Accept: 'application/json',
          // Overpass, like Nominatim, asks clients to identify themselves.
          'User-Agent': deps.userAgent,
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.error('[corridor] overpass', url, 'status', response.status);
        continue;
      }
      const data = (await response.json()) as {
        elements?: { type?: string; id?: number; lat?: number; lon?: number }[];
      };
      return (data.elements ?? [])
        .filter((e) => e.type === 'node' && typeof e.lat === 'number' && typeof e.lon === 'number')
        .map((e) => ({ osm_id: e.id as number, lat: e.lat as number, lng: e.lon as number }));
    } catch (e) {
      console.error('[corridor] overpass', url, 'failed:', (e as Error)?.message ?? e);
    }
  }
  return null;
}

export async function handler(req: Request, deps: Deps): Promise<Response> {
  let body: { origin?: unknown; destination?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  if (!isLatLng(body.origin) || !isLatLng(body.destination)) {
    return json(
      { error: 'origin and destination must be {latitude, longitude} within valid ranges.' },
      400,
    );
  }

  // OSRM takes lon,lat.
  const coords =
    `${body.origin.longitude},${body.origin.latitude};` +
    `${body.destination.longitude},${body.destination.latitude}`;
  const url =
    `${deps.routerUrl}/route/v1/driving/${coords}` +
    `?overview=full&geometries=geojson&alternatives=false&steps=false`;

  let data: {
    code?: string;
    routes?: { geometry?: { coordinates?: [number, number][] }; distance?: number; duration?: number }[];
  };
  try {
    const response = await deps.fetchImpl(url);
    data = await response.json();
  } catch {
    return json({ error: 'Routing request failed.' }, 502);
  }

  const best = data.routes?.[0];
  const lngLats = best?.geometry?.coordinates;
  if (data.code !== 'Ok' || !lngLats || lngLats.length < 2) {
    return json({ error: `Routing failed: ${data.code ?? 'NoRoute'}` }, 502);
  }

  // Half the point budget for OSRM's own points and half for densifying, so
  // the result always fits: densify adds at most length/spacing points plus
  // one per segment. Very long routes get coarser spacing rather than refused.
  const raw = samplePath(
    lngLats.map(([lng, lat]): Point => [lat, lng]),
    MAX_POINTS / 2,
  );
  const spacing = Math.max(SPACING_M, routeLength(raw) / (MAX_POINTS / 2));
  const route = densify(raw, spacing);

  const found = await findSignals(raw, deps);
  const signals = found
    ? orderAlongRoute(mergeJunctions(found, JUNCTION_MERGE_M), route).slice(0, MAX_SIGNALS)
    : [];

  return json(
    {
      route,
      distanceMeters: best?.distance ?? null,
      durationSeconds: best?.duration ?? null,
      signals,
      signalsAvailable: found !== null,
    },
    200,
  );
}
