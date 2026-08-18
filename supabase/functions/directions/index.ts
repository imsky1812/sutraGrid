// Deno entry point for the routing Edge Function.
//
// All logic lives in handler.ts, which has no Deno globals and is unit tested
// under Node. This file is wiring only.
//
// Deploy:  npx supabase functions deploy directions
//
// No API key is involved. Set ROUTER_URL to point at your own OSRM instance:
//   npx supabase secrets set ROUTER_URL=https://osrm.example.com

// @ts-ignore - Deno global is provided by the Supabase Edge runtime.
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): void;
};

import { handler, DEFAULT_ROUTER } from './handler.ts';

Deno.serve((req: Request) =>
  handler(req, {
    routerUrl: Deno.env.get('ROUTER_URL') ?? DEFAULT_ROUTER,
    fetchImpl: fetch,
  }),
);
