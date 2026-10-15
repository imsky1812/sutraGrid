// Deno entry point for the push Edge Function. Wiring only; the logic and its
// tests live in handler.ts.
//
// Deploy:  npx supabase functions deploy notify
//
// Called by the database, not by the app: the alerts trigger posts the new
// alert's id here through pg_net. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// are provided by the Edge runtime. The service-role key stays on the server;
// it is what lets this function claim alerts, which no client can.

// @ts-ignore - Deno global is provided by the Supabase Edge runtime.
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): void;
};

import { handler, DEFAULT_PUSH_URL } from './handler.ts';

Deno.serve((req: Request) =>
  handler(req, {
    supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '',
    serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    pushUrl: Deno.env.get('PUSH_URL') ?? DEFAULT_PUSH_URL,
    fetchImpl: fetch,
  }),
);
