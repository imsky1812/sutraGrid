import { supabase } from './supabase';
import { decodePolyline, LatLng } from './polyline';

/**
 * Fetch a driving route via the `directions` Edge Function.
 *
 * The Google Directions key lives in the function's environment, never in the
 * app bundle. The function returns only an encoded polyline, which is decoded
 * here rather than server-side to keep the payload small.
 */
export async function fetchRoute(origin: LatLng, destination: LatLng): Promise<LatLng[]> {
  const { data, error } = await supabase.functions.invoke('directions', {
    body: { origin, destination },
  });

  if (error) throw new Error(error.message);
  if (!data?.polyline) throw new Error('No route returned for that destination.');

  return decodePolyline(data.polyline);
}
