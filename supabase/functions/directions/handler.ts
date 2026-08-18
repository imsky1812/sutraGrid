// Request handler for the routing Edge Function.
//
// Deliberately free of Deno globals: dependencies come in as parameters so this
// can be unit tested under Node. index.ts supplies the real ones.
//
// Routing goes through OSRM, which needs no API key and no account. The app
// calls this function rather than the router directly so the provider can be
// swapped — to a self-hosted OSRM, OpenRouteService, or Valhalla — by
// redeploying the function, with no app rebuild and no store release.

export type LatLng = { latitude: number; longitude: number };

export type Deps = {
  /** Base URL of an OSRM-compatible router, without a trailing slash. */
  routerUrl: string;
  fetchImpl: typeof fetch;
};

/**
 * The public OSRM demo server. It is free and unauthenticated but explicitly
 * intended for light use, with no availability guarantee. Point `routerUrl` at
 * your own instance before relying on it for anything real.
 */
export const DEFAULT_ROUTER = 'https://router.project-osrm.org';

type OsrmResponse = {
  code?: string;
  message?: string;
  routes?: { geometry?: string; distance?: number; duration?: number }[];
};

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

  // OSRM takes lon,lat — the reverse of the order used everywhere else in this
  // codebase. Getting it backwards yields a plausible-looking route in the
  // wrong hemisphere rather than an error.
  const coords =
    `${body.origin.longitude},${body.origin.latitude};` +
    `${body.destination.longitude},${body.destination.latitude}`;

  const url =
    `${deps.routerUrl}/route/v1/driving/${coords}` +
    `?overview=full&geometries=polyline&alternatives=false&steps=false`;

  let response: Response;
  try {
    response = await deps.fetchImpl(url);
  } catch {
    return json({ error: 'Routing request failed.' }, 502);
  }

  let data: OsrmResponse;
  try {
    data = await response.json();
  } catch {
    return json({ error: 'Routing returned an unreadable response.' }, 502);
  }

  if (data.code !== 'Ok') {
    // OSRM's `code` is a fixed enum (NoRoute, InvalidQuery, ...). The free-text
    // `message` is logged rather than returned, so upstream wording never
    // becomes part of this contract.
    if (data.message) console.error('[directions] router said:', data.message);
    return json({ error: `Routing failed: ${data.code ?? 'UNKNOWN'}` }, 502);
  }

  const geometry = data.routes?.[0]?.geometry;
  if (!geometry) return json({ error: 'Routing failed: NoRoute' }, 502);

  // OSRM's polyline encoding is the same algorithm Google uses, so the client's
  // existing decoder applies unchanged.
  return json(
    {
      polyline: geometry,
      distanceMeters: data.routes?.[0]?.distance ?? null,
      durationSeconds: data.routes?.[0]?.duration ?? null,
    },
    200,
  );
}
