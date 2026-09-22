// Deno entry point for the green-corridor Edge Function. Wiring only; the logic
// and its tests live in handler.ts.
//
// Deploy:  npx supabase functions deploy corridor
//
// No API keys. ROUTER_URL and OVERPASS_URLS (comma-separated, tried in order)
// point at self-hosted instances when the public ones are not good enough.

// @ts-ignore - Deno global is provided by the Supabase Edge runtime.
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): void;
};

import { handler, DEFAULT_OVERPASS, DEFAULT_ROUTER, DEFAULT_USER_AGENT } from './handler.ts';

Deno.serve((req: Request) =>
  handler(req, {
    routerUrl: Deno.env.get('ROUTER_URL') ?? DEFAULT_ROUTER,
    overpassUrls: Deno.env.get('OVERPASS_URLS')?.split(',').map((u) => u.trim()) ?? DEFAULT_OVERPASS,
    userAgent: Deno.env.get('OVERPASS_USER_AGENT') ?? DEFAULT_USER_AGENT,
    fetchImpl: fetch,
  }),
);
