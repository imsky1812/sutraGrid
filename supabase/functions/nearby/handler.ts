// Request handler for the nearest-emergency-service Edge Function.
//
// The app's three emergency chips (hospital, fire station, police) used to be
// hardcoded Bengaluru coordinates with invented names, so a driver in Delhi
// tapping the police chip was routed two thousand kilometres south. This finds
// the real thing nearest to wherever the driver actually is.
//
// Photon first: it lists every amenity of a kind inside a box (a category
// search, so a hospital need not have "hospital" in its name), and it answers
// the Edge runtime. On 16 October every public Overpass server was refusing or
// timing out - even from an ordinary network - and Nominatim refuses the Edge
// runtime outright, so the Nearest buttons failed every time.
//
// Overpass is next, because "nearest amenity to this point" is exactly what it
// answers when it is up. Nominatim is the last resort: a text search, so it
// can only be biased toward a box, never sorted by distance.
//
// Google Places goes ahead of all of them when a key is configured. On the
// same day a driver in Ghaziabad found Google showing a police station and
// hospitals within 1-2 km, while OpenStreetMap had no police or fire station
// within 3 km at all: its coverage of Indian cities is far thinner. The key is
// a server secret (GOOGLE_PLACES_KEY), never in the app; without it this
// function behaves exactly as before.
//
// Like the other functions, this file has no Deno globals so it can be unit
// tested under Node; index.ts is the wiring.

export type LatLng = { latitude: number; longitude: number };

export type Place = {
  name: string;
  latitude: number;
  longitude: number;
  distanceMeters: number;
};

export type Deps = {
  /** Tried in order; the public servers are often busy. */
  overpassUrls: string[];
  /** Google Places API key, tried first when set. */
  googleKey?: string;
  /** Overridable for tests. */
  googleUrl?: string;
  /** Photon-compatible geocoder, tried next. Without one, Overpass next. */
  photonUrl?: string;
  geocoderUrl: string;
  userAgent: string;
  fetchImpl: typeof fetch;
};

export const DEFAULT_OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
export const DEFAULT_GEOCODER = 'https://nominatim.openstreetmap.org';
export const DEFAULT_PHOTON = 'https://photon.komoot.io';
export const DEFAULT_GOOGLE = 'https://places.googleapis.com/v1/places:searchNearby';
export const DEFAULT_USER_AGENT = 'SUTRA-traffic/1.0 (emergency service finder)';

/** Per server. A driver is waiting on this, so give up quickly. */
const TIMEOUT_MS = 12_000;

/** What each chip means in OpenStreetMap, and what to call an unnamed one. */
export const KINDS = {
  hospital: { tag: 'amenity=hospital', category: 'osm.amenity.hospital', google: 'hospital', label: 'Hospital' },
  fire: { tag: 'amenity=fire_station', category: 'osm.amenity.fire_station', google: 'fire_station', label: 'Fire station' },
  police: { tag: 'amenity=police', category: 'osm.amenity.police', google: 'police', label: 'Police station' },
} as const;

export type Kind = keyof typeof KINDS;

/** Widened until something is found: a village may have nothing within 5 km. */
export const RADII_M = [5_000, 15_000, 40_000];
export const MAX_RESULTS = 5;

type Point = [number, number]; // [lat, lng]

/** Same planar approximation the database uses, so both agree on distances. */
export function distanceM(a: Point, b: Point): number {
  const dy = (b[0] - a[0]) * 110540;
  const dx = (b[1] - a[1]) * 111320 * Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
  return Math.sqrt(dx * dx + dy * dy);
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

type Element = {
  type?: string;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
};

/** A hospital is usually mapped as a building outline, so `out center` is required. */
function toPlaces(elements: Element[], kind: Kind, near: LatLng): Place[] {
  const origin: Point = [near.latitude, near.longitude];
  return elements
    .map((e) => {
      const lat = typeof e.lat === 'number' ? e.lat : e.center?.lat;
      const lng = typeof e.lon === 'number' ? e.lon : e.center?.lon;
      if (typeof lat !== 'number' || typeof lng !== 'number') return null;
      return {
        // An unnamed one is still somewhere to drive to.
        name: e.tags?.name ?? e.tags?.['name:en'] ?? KINDS[kind].label,
        latitude: lat,
        longitude: lng,
        distanceMeters: distanceM(origin, [lat, lng]),
      };
    })
    .filter((p): p is Place => p !== null);
}

export function nearest(places: Place[], max = MAX_RESULTS): Place[] {
  return [...places].sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, max);
}

/** A box `radius` metres each way from the driver, as Photon's minLon,minLat,maxLon,maxLat. */
export function bboxAround(near: LatLng, radius: number): string {
  const dLat = radius / 110540;
  const dLng = radius / (111320 * Math.cos((near.latitude * Math.PI) / 180));
  return [near.longitude - dLng, near.latitude - dLat, near.longitude + dLng, near.latitude + dLat]
    .map((v) => v.toFixed(5))
    .join(',');
}

type GooglePlace = {
  displayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
};

/**
 * Google Places Nearby Search, ranked by distance, widening like the others.
 * Asks only for name and location, which keeps each call in the cheapest
 * billing tier that can answer it. Null when Google could not be used.
 */
async function findViaGoogle(kind: Kind, near: LatLng, deps: Deps): Promise<Place[] | null> {
  if (!deps.googleKey) return null;
  const origin: Point = [near.latitude, near.longitude];
  let reached = false;

  for (const radius of RADII_M) {
    try {
      const response = await deps.fetchImpl(deps.googleUrl ?? DEFAULT_GOOGLE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': deps.googleKey,
          'X-Goog-FieldMask': 'places.displayName,places.location',
        },
        body: JSON.stringify({
          includedTypes: [KINDS[kind].google],
          maxResultCount: 20,
          rankPreference: 'DISTANCE',
          locationRestriction: {
            circle: { center: { latitude: near.latitude, longitude: near.longitude }, radius },
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        // A bad key, billing switched off or a quota: say so in the logs, and
        // let the free sources answer.
        console.error('[nearby] google status', response.status, await response.text().catch(() => ''));
        return reached ? [] : null;
      }
      const data = (await response.json()) as { places?: GooglePlace[] };
      reached = true;
      const places = nearest(
        (data.places ?? [])
          .map((p) => {
            const lat = p.location?.latitude;
            const lng = p.location?.longitude;
            if (typeof lat !== 'number' || typeof lng !== 'number') return null;
            return {
              name: p.displayName?.text || KINDS[kind].label,
              latitude: lat,
              longitude: lng,
              distanceMeters: distanceM(origin, [lat, lng]),
            };
          })
          .filter((p): p is Place => p !== null),
      );
      if (places.length > 0) return places;
    } catch (e) {
      console.error('[nearby] google failed:', (e as Error)?.message ?? e);
      return reached ? [] : null;
    }
  }
  return reached ? [] : null;
}

/** Per box. Photon returns its own ranking, not distance, so ask for plenty and sort. */
const PHOTON_LIMIT = 50;

type PhotonFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: { name?: string };
};

/**
 * Every mapped amenity of this kind in a box around the driver, widening the
 * box until something turns up. Null when Photon could not be reached.
 */
async function findViaPhoton(kind: Kind, near: LatLng, deps: Deps): Promise<Place[] | null> {
  if (!deps.photonUrl) return null;
  const origin: Point = [near.latitude, near.longitude];
  let reached = false;

  for (const radius of RADII_M) {
    const url = new URL(`${deps.photonUrl}/api/`);
    url.searchParams.set('include', KINDS[kind].category);
    url.searchParams.set('bbox', bboxAround(near, radius));
    url.searchParams.set('lat', String(near.latitude));
    url.searchParams.set('lon', String(near.longitude));
    url.searchParams.set('limit', String(PHOTON_LIMIT));
    url.searchParams.set('lang', 'en');

    try {
      const response = await deps.fetchImpl(url.toString(), {
        headers: { 'User-Agent': deps.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        console.error('[nearby] photon status', response.status);
        return reached ? [] : null;
      }
      const data = (await response.json()) as { features?: PhotonFeature[] };
      reached = true;
      const places = nearest(
        (data.features ?? [])
          .map((f) => {
            // GeoJSON order: longitude first.
            const lat = Number(f.geometry?.coordinates?.[1]);
            const lng = Number(f.geometry?.coordinates?.[0]);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            return {
              name: f.properties?.name || KINDS[kind].label,
              latitude: lat,
              longitude: lng,
              distanceMeters: distanceM(origin, [lat, lng]),
            };
          })
          .filter((p): p is Place => p !== null),
      );
      if (places.length > 0) return places;
    } catch (e) {
      console.error('[nearby] photon failed:', (e as Error)?.message ?? e);
      return reached ? [] : null;
    }
  }
  return reached ? [] : null;
}

/**
 * Ask Overpass for this amenity around the driver, widening the search until
 * something turns up. Returns null when every mirror failed, which is different
 * from an empty array: nothing nearby is an answer, a dead server is not.
 */
async function findViaOverpass(
  kind: Kind,
  near: LatLng,
  deps: Deps,
): Promise<Place[] | null> {
  const at = `${near.latitude.toFixed(6)},${near.longitude.toFixed(6)}`;
  let reachedAServer = false;

  for (const radius of RADII_M) {
    const query =
      `[out:json][timeout:20];` +
      `nwr(around:${radius},${at})[${KINDS[kind].tag}];` +
      `out center ${MAX_RESULTS * 12};`;

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
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
          console.error('[nearby] overpass', url, 'status', response.status);
          continue;
        }

        const data = (await response.json()) as { elements?: Element[] };
        reachedAServer = true;
        const places = nearest(toPlaces(data.elements ?? [], kind, near));
        // Found something: stop widening and stop trying mirrors.
        if (places.length > 0) return places;
        // Empty at this radius: widen rather than ask the next mirror the
        // same question it just answered.
        break;
      } catch (e) {
        console.error('[nearby] overpass', url, 'failed:', (e as Error)?.message ?? e);
      }
    }
  }

  return reachedAServer ? [] : null;
}

/**
 * Nominatim fallback. `bounded=1` is what makes this local: without it the
 * viewbox is only a soft preference and a search for "hospital" happily
 * returns one in another state.
 */
async function findViaGeocoder(kind: Kind, near: LatLng, deps: Deps): Promise<Place[] | null> {
  // Roughly the widest Overpass radius, in degrees.
  const pad = 0.4;
  const url = new URL(`${deps.geocoderUrl}/search`);
  url.searchParams.set('q', KINDS[kind].label);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '20');
  url.searchParams.set('bounded', '1');
  url.searchParams.set(
    'viewbox',
    `${near.longitude - pad},${near.latitude + pad},${near.longitude + pad},${near.latitude - pad}`,
  );

  try {
    const response = await deps.fetchImpl(url.toString(), {
      headers: { 'User-Agent': deps.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error('[nearby] nominatim status', response.status);
      return null;
    }

    const raw = (await response.json()) as
      | { display_name?: string; name?: string; lat?: string; lon?: string }[]
      | null;
    if (!Array.isArray(raw)) return null;

    const origin: Point = [near.latitude, near.longitude];
    return nearest(
      raw
        .map((entry) => ({
          name: entry.display_name ?? entry.name ?? KINDS[kind].label,
          latitude: Number(entry.lat),
          longitude: Number(entry.lon),
        }))
        .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
        .map((p) => ({ ...p, distanceMeters: distanceM(origin, [p.latitude, p.longitude]) })),
    );
  } catch (e) {
    console.error('[nearby] nominatim failed:', (e as Error)?.message ?? e);
    return null;
  }
}

export async function handler(req: Request, deps: Deps): Promise<Response> {
  let body: { kind?: unknown; near?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  if (typeof body.kind !== 'string' || !(body.kind in KINDS)) {
    return json({ error: `kind must be one of: ${Object.keys(KINDS).join(', ')}.` }, 400);
  }
  if (!isLatLng(body.near)) {
    return json({ error: 'near must be {latitude, longitude} within valid ranges.' }, 400);
  }

  const kind = body.kind as Kind;
  const near = body.near;

  const viaGoogle = await findViaGoogle(kind, near, deps);
  if (viaGoogle && viaGoogle.length > 0) {
    return json({ places: viaGoogle, source: 'google' }, 200);
  }

  const viaPhoton = await findViaPhoton(kind, near, deps);
  if (viaPhoton && viaPhoton.length > 0) {
    return json({ places: viaPhoton, source: 'photon' }, 200);
  }

  // Photon empty or down: Overpass may know of one Photon has not indexed.
  const viaOverpass = await findViaOverpass(kind, near, deps);
  if (viaOverpass && viaOverpass.length > 0) {
    return json({ places: viaOverpass, source: 'overpass' }, 200);
  }

  const viaGeocoder = await findViaGeocoder(kind, near, deps);
  if (viaGeocoder && viaGeocoder.length > 0) {
    return json({ places: viaGeocoder, source: 'nominatim' }, 200);
  }

  // Reached and genuinely empty, and the geocoder added nothing: there really
  // is no such service mapped near this driver.
  if (viaOverpass) return json({ places: [], source: 'overpass' }, 200);
  if (viaPhoton) return json({ places: [], source: 'photon' }, 200);
  if (viaGoogle) return json({ places: [], source: 'google' }, 200);

  return json({ error: `Could not look up the nearest ${KINDS[kind].label.toLowerCase()}.` }, 502);
}
