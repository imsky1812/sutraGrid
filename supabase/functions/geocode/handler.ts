// Geocoding for the destination search box.
//
// Uses Nominatim (OpenStreetMap), which needs no API key. Nominatim's usage
// policy requires a genuine User-Agent and asks for light use, which is why
// this sits behind a function: the provider can be swapped, and the identifying
// header lives in one place rather than in every client.

export type LatLng = { latitude: number; longitude: number };

export type Deps = {
  geocoderUrl: string;
  userAgent: string;
  fetchImpl: typeof fetch;
};

export const DEFAULT_GEOCODER = 'https://nominatim.openstreetmap.org';
export const DEFAULT_USER_AGENT = 'SUTRA-Traffic/1.0 (vehicle telemetry demo)';

type NominatimPlace = { display_name?: string; name?: string; lat?: string; lon?: string };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const inRange = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

const isLatLng = (v: unknown): v is LatLng => {
  const p = v as LatLng | null;
  return !!p && typeof p === 'object' && inRange(p.latitude, -90, 90) && inRange(p.longitude, -180, 180);
};

/** Nominatim returns strings; anything unparseable is dropped rather than shown. */
function toPlaces(raw: unknown): { name: string; latitude: number; longitude: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: NominatimPlace) => ({
      name: entry.display_name ?? entry.name ?? '',
      latitude: Number(entry.lat),
      longitude: Number(entry.lon),
    }))
    .filter((p) => p.name && Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
    .slice(0, 8);
}

export async function handler(req: Request, deps: Deps): Promise<Response> {
  let body: { query?: unknown; near?: unknown; reverse?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  let url: URL;

  if (isLatLng(body.reverse)) {
    url = new URL(`${deps.geocoderUrl}/reverse`);
    url.searchParams.set('lat', String(body.reverse.latitude));
    url.searchParams.set('lon', String(body.reverse.longitude));
    url.searchParams.set('format', 'json');
    url.searchParams.set('zoom', '18');
  } else if (typeof body.query === 'string' && body.query.trim().length >= 3) {
    url = new URL(`${deps.geocoderUrl}/search`);
    url.searchParams.set('q', body.query.trim().slice(0, 200));
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '8');
    url.searchParams.set('addressdetails', '0');

    // Bias results toward the driver so "hospital" means a nearby one.
    if (isLatLng(body.near)) {
      const { latitude, longitude } = body.near;
      const pad = 0.5;
      url.searchParams.set(
        'viewbox',
        `${longitude - pad},${latitude + pad},${longitude + pad},${latitude - pad}`,
      );
    }
  } else {
    return json({ error: 'Provide a query of at least 3 characters, or a reverse coordinate.' }, 400);
  }

  let response: Response;
  try {
    response = await deps.fetchImpl(url.toString(), {
      headers: { 'User-Agent': deps.userAgent, Accept: 'application/json' },
    });
  } catch {
    return json({ error: 'Geocoding request failed.' }, 502);
  }

  if (!response.ok) return json({ error: `Geocoding failed: ${response.status}` }, 502);

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return json({ error: 'Geocoding returned an unreadable response.' }, 502);
  }

  // Reverse lookups return a single object; search returns an array.
  const places = Array.isArray(raw) ? toPlaces(raw) : toPlaces([raw]);
  return json({ places }, 200);
}
