// Deno entry point for signal dispatch. Wiring only; the logic and its tests
// live in handler.ts, and the contract in docs/signal-adapter.md.
//
// Deploy:  npx supabase functions deploy signal-dispatch
//
// Inert until an authority connects a controller:
//   npx supabase secrets set SIGNAL_ADAPTER_URL=https://... SIGNAL_ADAPTER_SECRET=...
// and sets the setting signal_adapter_mode to "http". Until then commands are
// recorded as SIMULATED and this is never called.

// @ts-ignore - Deno global is provided by the Supabase Edge runtime.
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): void;
};

import { handler } from './handler.ts';

Deno.serve((req: Request) =>
  handler(req, {
    supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '',
    serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    adapterUrl: Deno.env.get('SIGNAL_ADAPTER_URL'),
    adapterSecret: Deno.env.get('SIGNAL_ADAPTER_SECRET'),
    maxHoldSeconds: Number(Deno.env.get('SIGNAL_MAX_HOLD_SECONDS') ?? 120),
    fetchImpl: fetch,
  }),
);
