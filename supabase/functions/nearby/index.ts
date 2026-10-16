// Deno entry point for the nearest-emergency-service Edge Function. Wiring
// only; the logic and its tests live in handler.ts.
//
// Deploy:  npx supabase functions deploy nearby
//
// No API keys. OVERPASS_URLS (comma-separated, tried in order) and
// GEOCODER_URL point at self-hosted instances when the public ones are not
// good enough.

// @ts-ignore - Deno global is provided by the Supabase Edge runtime.
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): void;
};

import {
  handler,
  DEFAULT_GEOCODER,
  DEFAULT_OVERPASS,
  DEFAULT_PHOTON,
  DEFAULT_USER_AGENT,
} from './handler.ts';

Deno.serve((req: Request) =>
  handler(req, {
    // Optional. Set as a Supabase secret, never in the app:
    //   Dashboard > Edge Functions > Secrets > GOOGLE_PLACES_KEY
    googleKey: Deno.env.get('GOOGLE_PLACES_KEY') || undefined,
    photonUrl: Deno.env.get('PHOTON_URL') ?? DEFAULT_PHOTON,
    overpassUrls: Deno.env.get('OVERPASS_URLS')?.split(',').map((u) => u.trim()) ?? DEFAULT_OVERPASS,
    geocoderUrl: Deno.env.get('GEOCODER_URL') ?? DEFAULT_GEOCODER,
    userAgent: Deno.env.get('OVERPASS_USER_AGENT') ?? DEFAULT_USER_AGENT,
    fetchImpl: fetch,
  }),
);
