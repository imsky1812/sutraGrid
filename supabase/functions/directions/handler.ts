// Request handler for the Directions Edge Function.
//
// Deliberately free of Deno globals: dependencies come in as parameters so this
// can be unit tested under Node. index.ts supplies the real ones.
//
// The purpose of this proxy is that the Google Directions key stays server-side
// instead of being bundled into the APK. That means nothing from upstream may
// be echoed verbatim — the key travels in the request URL, so an upstream error
// message can contain it.

export type LatLng = { latitude: number; longitude: number };

export type Deps = {
  apiKey: string;
  fetchImpl: typeof fetch;
};

const DIRECTIONS_URL = 'https://maps.googleapis.com/maps/api/directions/json';

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
  if (!deps.apiKey) {
    // Fail closed. Calling Google without a key would just return
    // REQUEST_DENIED, which is a confusing way to report a misconfiguration.
    return json({ error: 'Directions API key is not configured on the server.' }, 500);
  }

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

  const url = new URL(DIRECTIONS_URL);
  url.searchParams.set('origin', `${body.origin.latitude},${body.origin.longitude}`);
  url.searchParams.set('destination', `${body.destination.latitude},${body.destination.longitude}`);
  url.searchParams.set('mode', 'driving');
  url.searchParams.set('key', deps.apiKey);

  let data: { status?: string; routes?: { overview_polyline?: { points?: string } }[] };
  try {
    const upstream = await deps.fetchImpl(url.toString());
    data = await upstream.json();
  } catch {
    // The thrown error can quote the request URL, key included, so it is not
    // surfaced to the caller.
    return json({ error: 'Directions request failed.' }, 502);
  }

  const points = data.routes?.[0]?.overview_polyline?.points;
  if (data.status !== 'OK' || !points) {
    // Only the status code is echoed. It is a fixed enum from Google and
    // carries no request details.
    return json({ error: `Directions failed: ${data.status ?? 'UNKNOWN'}` }, 502);
  }

  return json({ polyline: points }, 200);
}
