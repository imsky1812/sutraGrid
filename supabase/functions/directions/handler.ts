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

// Routes API, not the legacy Directions API. Google Cloud projects created from
// early 2025 onward cannot enable the legacy endpoint at all — it answers
// REQUEST_DENIED with "You're calling a legacy API, which is not enabled for
// your project", regardless of the key.
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

type RoutesResponse = {
  routes?: { polyline?: { encodedPolyline?: string } }[];
  error?: { status?: string; message?: string };
};

const point = (p: LatLng) => ({ latitude: p.latitude, longitude: p.longitude });

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

  // The key travels in a header here rather than the query string, so it is
  // less likely to end up in an upstream error message or a proxy log.
  let response: Response;
  try {
    response = await deps.fetchImpl(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': deps.apiKey,
        // Ask for only the encoded polyline. Without a field mask the Routes
        // API rejects the request outright.
        'X-Goog-FieldMask': 'routes.polyline.encodedPolyline',
      },
      body: JSON.stringify({
        origin: { location: { latLng: point(body.origin) } },
        destination: { location: { latLng: point(body.destination) } },
        travelMode: 'DRIVE',
      }),
    });
  } catch {
    // A thrown fetch error can quote the request, so it is not passed on.
    return json({ error: 'Directions request failed.' }, 502);
  }

  let data: RoutesResponse;
  try {
    data = await response.json();
  } catch {
    return json({ error: 'Directions returned an unreadable response.' }, 502);
  }

  if (!response.ok) {
    // Echo the status enum only. Google's message can name the project and
    // quote request details, so it is logged rather than returned.
    console.error('[directions] upstream error', data?.error?.status ?? response.status);
    return json({ error: `Directions failed: ${data?.error?.status ?? response.status}` }, 502);
  }

  const points = data.routes?.[0]?.polyline?.encodedPolyline;
  if (!points) return json({ error: 'Directions failed: ZERO_RESULTS' }, 502);

  return json({ polyline: points }, 200);
}
