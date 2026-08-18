// Deno entry point for the geocoding Edge Function. Wiring only; the logic and
// its tests live in handler.ts.

// @ts-ignore - Deno global is provided by the Supabase Edge runtime.
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): void;
};

import { handler, DEFAULT_GEOCODER, DEFAULT_USER_AGENT } from './handler.ts';

Deno.serve((req: Request) =>
  handler(req, {
    geocoderUrl: Deno.env.get('GEOCODER_URL') ?? DEFAULT_GEOCODER,
    userAgent: Deno.env.get('GEOCODER_USER_AGENT') ?? DEFAULT_USER_AGENT,
    fetchImpl: fetch,
  }),
);
