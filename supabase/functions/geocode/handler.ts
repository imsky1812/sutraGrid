// Geocoding for the destination search box.
//
// Two OpenStreetMap geocoders, neither needing an API key:
//
//  - Photon (photon.komoot.io), tried first. It answers requests from the
//    Edge runtime.
//  - Nominatim, kept as the fallback. Since 16 October it answers every
//    request from the Edge runtime with 403 - the same treatment Overpass
//    gives it - which left the app's place search failing on every query.
//
// This sits behind a function so the provider can be swapped by redeploying,
// and the identifying User-Agent both ask for lives in one place.

export type LatLng = { latitude: number; longitude: number };

export type Deps = {
  /** Nominatim-compatible geocoder: the fallback. */
  geocoderUrl: string;
  /** Photon-compatible geocoder, tried first. Without one, Nominatim only. */
  photonUrl?: string;
  userAgent: string;
  fetchImpl: typeof fetch;
};

export const DEFAULT_GEOCODER = 'https://nominatim.openstreetmap.org';
export const DEFAULT_PHOTON = 'https://photon.komoot.io';
export const DEFAULT_USER_AGENT = 'SUTRA-Traffic/1.0 (vehicle telemetry demo)';

type Place = { name: string; latitude: number; longitude: number };
type NominatimPlace = { display_name?: string; name?: string; lat?: string; lon?: string };
type PhotonFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, string | undefined>;
};

const MAX_RESULTS = 8;

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

/** Anything without a name or usable coordinates is dropped rather than shown. */
const usable = (p: Place) => !!p.name && Number.isFinite(p.latitude) && Number.isFinite(p.longitude);

/** Nominatim returns strings for coordinates. */
function fromNominatim(raw: unknown): Place[] {
  // Reverse lookups return a single object; search returns an array.
  const rows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  return rows
    .map((entry: NominatimPlace) => ({
      name: entry.display_name ?? entry.name ?? '',
      latitude: Number(entry.lat),
      longitude: Number(entry.lon),
    }))
    .filter(usable)
    .slice(0, MAX_RESULTS);
}

/**
 * Photon returns GeoJSON with the address in parts, so the label is built:
 * the place itself, then the area, city and state - "Ghaziabad Junction,
 * Railway Road, Ghaziabad, Uttar Pradesh".
 */
export function photonLabel(p: Record<string, string | undefined>): string {
  const street = p.street ? [p.housenumber, p.street].filter(Boolean).join(' ') : undefined;
  const parts = [p.name, street, p.district ?? p.locality, p.city ?? p.county, p.state];
  return parts
    .filter((part): part is string => !!part && part.trim().length > 0)
    .filter((part, i, all) => all.indexOf(part) === i)
    .join(', ');
}

function fromPhoton(raw: unknown): Place[] {
  const features = (raw as { features?: unknown })?.features;
  if (!Array.isArray(features)) return [];
  return features
    .map((f: PhotonFeature) => ({
      name: photonLabel(f.properties ?? {}),
      // GeoJSON order: longitude first.
      latitude: Number(f.geometry?.coordinates?.[1]),
      longitude: Number(f.geometry?.coordinates?.[0]),
    }))
    .filter(usable)
    .slice(0, MAX_RESULTS);
}

type Request_ = { query?: string; near?: LatLng; reverse?: LatLng };

function photonUrl(base: string, r: Request_): string {
  const url = r.reverse ? new URL(`${base}/reverse`) : new URL(`${base}/api/`);
  if (r.reverse) {
    url.searchParams.set('lat', String(r.reverse.latitude));
    url.searchParams.set('lon', String(r.reverse.longitude));
    url.searchParams.set('limit', '1');
  } else {
    url.searchParams.set('q', r.query!);
    url.searchParams.set('limit', String(MAX_RESULTS));
    // Bias toward the driver so "hospital" means a nearby one.
    if (r.near) {
      url.searchParams.set('lat', String(r.near.latitude));
      url.searchParams.set('lon', String(r.near.longitude));
    }
  }
  url.searchParams.set('lang', 'en');
  return url.toString();
}

function nominatimUrl(base: string, r: Request_): string {
  let url: URL;
  if (r.reverse) {
    url = new URL(`${base}/reverse`);
    url.searchParams.set('lat', String(r.reverse.latitude));
    url.searchParams.set('lon', String(r.reverse.longitude));
    url.searchParams.set('zoom', '18');
  } else {
    url = new URL(`${base}/search`);
    url.searchParams.set('q', r.query!);
    url.searchParams.set('limit', String(MAX_RESULTS));
    url.searchParams.set('addressdetails', '0');
    if (r.near) {
      const { latitude, longitude } = r.near;
      const pad = 0.5;
      url.searchParams.set(
        'viewbox',
        `${longitude - pad},${latitude + pad},${longitude + pad},${latitude - pad}`,
      );
    }
  }
  url.searchParams.set('format', 'json');
  return url.toString();
}

/** One provider's answer: places, or why it failed. */
async function ask(
  deps: Deps,
  url: string,
  parse: (raw: unknown) => Place[],
): Promise<{ places: Place[] } | { error: string }> {
  let response: Response;
  try {
    response = await deps.fetchImpl(url, {
      headers: { 'User-Agent': deps.userAgent, Accept: 'application/json' },
    });
  } catch {
    return { error: 'Geocoding request failed.' };
  }
  if (!response.ok) return { error: `Geocoding failed: ${response.status}` };
  try {
    return { places: parse(await response.json()) };
  } catch {
    return { error: 'Geocoding returned an unreadable response.' };
  }
}

export async function handler(req: Request, deps: Deps): Promise<Response> {
  let body: { query?: unknown; near?: unknown; reverse?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  let request: Request_;
  if (isLatLng(body.reverse)) {
    request = { reverse: body.reverse };
  } else if (typeof body.query === 'string' && body.query.trim().length >= 3) {
    request = {
      query: body.query.trim().slice(0, 200),
      near: isLatLng(body.near) ? body.near : undefined,
    };
  } else {
    return json({ error: 'Provide a query of at least 3 characters, or a reverse coordinate.' }, 400);
  }

  const attempts: [string, (raw: unknown) => Place[]][] = [];
  if (deps.photonUrl) attempts.push([photonUrl(deps.photonUrl, request), fromPhoton]);
  attempts.push([nominatimUrl(deps.geocoderUrl, request), fromNominatim]);

  // The first provider that answers wins. An empty answer is an answer: a
  // search with no matches should not wait on a second provider to agree.
  let lastError = 'Geocoding failed.';
  for (const [url, parse] of attempts) {
    const result = await ask(deps, url, parse);
    if ('places' in result) return json({ places: result.places }, 200);
    lastError = result.error;
  }
  return json({ error: lastError }, 502);
}
