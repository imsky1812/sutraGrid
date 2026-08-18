// Deno entry point for the Directions Edge Function.
//
// All logic lives in handler.ts, which has no Deno globals and is unit tested
// under Node. This file is wiring only.
//
// Deploy:  npx supabase functions deploy directions
// Secret:  npx supabase secrets set GOOGLE_DIRECTIONS_KEY=...

// @ts-ignore - Deno global is provided by the Supabase Edge runtime.
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): void;
};

import { handler } from './handler.ts';

Deno.serve((req: Request) =>
  handler(req, {
    apiKey: Deno.env.get('GOOGLE_DIRECTIONS_KEY') ?? '',
    fetchImpl: fetch,
  }),
);
