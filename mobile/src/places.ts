import { supabase } from './supabase';

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
