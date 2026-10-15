import { supabase } from './supabase';
import { distanceM } from './geo';

export type Place = {
  name: string;
  latitude: number;
  longitude: number;
};

/**
 * Search for a place by name or address.
 *
 * Goes through the `geocode` Edge Function rather than calling a provider
 * directly, for the same reason routing does: the provider can be swapped by
 * redeploying a function instead of shipping a new APK, and the app carries no
 * provider credentials.
 */
export async function searchPlaces(query: string, near?: { latitude: number; longitude: number }) {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  const { data, error } = await supabase.functions.invoke('geocode', {
    body: { query: trimmed, near },
  });

  if (error) throw new Error(error.message);
  return (data?.places ?? []) as Place[];
}

/** Turn a map coordinate into a readable label, falling back to the numbers. */
export async function describePoint(latitude: number, longitude: number): Promise<string> {
  try {
    const { data } = await supabase.functions.invoke('geocode', {
      body: { reverse: { latitude, longitude } },
    });
    if (data?.places?.[0]?.name) return data.places[0].name as string;
  } catch {
    // A missing label is not worth failing a destination over.
  }
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

/** The emergency services the dashboard offers as one-tap destinations. */
export type ServiceKind = 'hospital' | 'fire' | 'police';

export type NearestPlace = Place & { distanceMeters: number };

/** What each one means in OpenStreetMap, and what to call an unnamed one. */
const SERVICE_TAG: Record<ServiceKind, { tag: string; label: string }> = {
  hospital: { tag: 'amenity=hospital', label: 'Hospital' },
  fire: { tag: 'amenity=fire_station', label: 'Fire station' },
  police: { tag: 'amenity=police', label: 'Police station' },
};

/** Must match the Edge Function, so both widen the same way. */
const RADII_M = [5_000, 15_000, 40_000];
const MAX_RESULTS = 5;
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_TIMEOUT_MS = 12_000;

/**
 * The nearest hospital, fire station or police station to the driver.
 *
 * These were three hardcoded Bengaluru coordinates until a driver in Delhi
 * tapped one and was routed two thousand kilometres south. There is no sensible
 * fallback: without a location there is no "nearest", so the caller must have
 * one before asking.
 */
export async function findNearestServices(
  kind: ServiceKind,
  near: { latitude: number; longitude: number },
  fetchImpl: typeof fetch = fetch,
): Promise<NearestPlace[]> {
  const { data, error } = await supabase.functions.invoke('nearby', {
    body: { kind, near },
  });

  const places = (data?.places ?? []) as NearestPlace[];
  if (!error && places.length > 0) return places;

  // Measured, not assumed: from the Edge runtime overpass-api.de answers 406,
  // the kumi mirror 500 and Nominatim 403, while the identical query from an
  // ordinary network returns 200. The phone is a second, independent chance,
  // exactly as it is for the corridor's junctions.
  const fromDevice = await findNearestFromDevice(kind, near, fetchImpl);
  if (fromDevice) return fromDevice;

  if (error) throw new Error(error.message);
  return places;
}

type OverpassElement = {
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
};

/** Overpass straight from the phone, or null if that failed too. */
export async function findNearestFromDevice(
  kind: ServiceKind,
  near: { latitude: number; longitude: number },
  fetchImpl: typeof fetch = fetch,
): Promise<NearestPlace[] | null> {
  const at = `${near.latitude.toFixed(6)},${near.longitude.toFixed(6)}`;
  let reachedTheServer = false;

  for (const radius of RADII_M) {
    const query =
      `[out:json][timeout:20];` +
      `nwr(around:${radius},${at})[${SERVICE_TAG[kind].tag}];` +
      `out center ${MAX_RESULTS * 12};`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
      const response = await fetchImpl(OVERPASS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          // overpass-api.de answers 406 to generic library agents, and okhttp's
          // is what React Native's fetch sends on Android by default.
          'User-Agent': 'SUTRA-traffic/1.0 (emergency service finder)',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (!response.ok) return null;

      const data = (await response.json()) as { elements?: OverpassElement[] };
      reachedTheServer = true;
      const found = (data.elements ?? [])
        .map((e) => {
          const latitude = typeof e.lat === 'number' ? e.lat : e.center?.lat;
          const longitude = typeof e.lon === 'number' ? e.lon : e.center?.lon;
          if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
          return {
            // An unnamed one is still somewhere to drive to.
            name: e.tags?.name ?? e.tags?.['name:en'] ?? SERVICE_TAG[kind].label,
            latitude,
            longitude,
            distanceMeters: distanceM([near.latitude, near.longitude], [latitude, longitude]),
          };
        })
        .filter((p): p is NearestPlace => p !== null)
        .sort((a, b) => a.distanceMeters - b.distanceMeters)
        .slice(0, MAX_RESULTS);

      if (found.length > 0) return found;
      // Nothing at this radius: widen rather than give up.
    } catch {
      return null;
    }
  }

  // Reached and genuinely empty is an answer; unreachable is not.
  return reachedTheServer ? [] : null;
}
