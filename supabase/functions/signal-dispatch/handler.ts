// Deliver one signal command to a city's traffic-signal controller.
//
// Only runs when an authority has set signal_adapter_mode to 'http'; in the
// default simulation mode commands are recorded and nothing calls this. The
// contract it speaks is docs/signal-adapter.md, and tools/mock-signal-adapter.mjs
// is a reference implementation of the city's side.
//
// Like the other functions, no Deno globals here, so it can be tested under
// Node; index.ts is the wiring.

export type Deps = {
  supabaseUrl: string;
  serviceKey: string;
  /** The city's endpoint. Unset means nothing is sent. */
  adapterUrl: string | undefined;
  /** Shared with the city, to sign every request. */
  adapterSecret: string | undefined;
  /**
   * How long a junction may be held without a RELEASE before the controller
   * must give up on its own. Sent with every command: SUTRA, a phone network
   * or this function can all fail, and a junction must not stay held because
   * of it.
   */
  maxHoldSeconds: number;
  fetchImpl: typeof fetch;
  now?: () => number;
};

export const CONTRACT_VERSION = 1;
const ADAPTER_TIMEOUT_MS = 5_000;

type Command = {
  id: number;
  corridor_id: string;
  osm_id: number | null;
  lat: number | null;
  lng: number | null;
  command: 'PREEMPT' | 'HOLD_GREEN' | 'RELEASE';
  eta_s: number | null;
  approach_deg: number | null;
  vehicle_type: string | null;
  issued_at: string;
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * HMAC-SHA256 over "<timestamp>.<body>", the scheme the contract specifies.
 * Including the timestamp lets the city reject a replayed request.
 */
export async function signPayload(secret: string, timestamp: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${body}`)));
}

/** The request body, exactly as docs/signal-adapter.md describes it. */
export function payloadFor(c: Command, maxHoldSeconds: number) {
  return {
    version: CONTRACT_VERSION,
    command_id: c.id,
    command: c.command,
    issued_at: c.issued_at,
    junction: { osm_id: c.osm_id, lat: c.lat, lng: c.lng },
    approach_bearing_deg: c.approach_deg,
    eta_seconds: c.eta_s,
    vehicle_type: c.vehicle_type,
    corridor_id: c.corridor_id,
    max_hold_seconds: maxHoldSeconds,
  };
}

async function rpc<T>(deps: Deps, name: string, args: unknown): Promise<T> {
  const response = await deps.fetchImpl(`${deps.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: deps.serviceKey,
      Authorization: `Bearer ${deps.serviceKey}`,
    },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${name} failed: ${response.status}`);
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

const record = (deps: Deps, id: number, status: string, response: unknown) =>
  rpc(deps, 'record_signal_response', { p_command_id: id, p_status: status, p_response: response });

export async function handler(req: Request, deps: Deps): Promise<Response> {
  let body: { command_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  const id = Number(body.command_id);
  if (!Number.isInteger(id) || id <= 0) {
    return json({ error: 'command_id must be a positive integer.' }, 400);
  }

  let claimed: Command[];
  try {
    claimed = await rpc<Command[]>(deps, 'claim_signal_command', { p_command_id: id });
  } catch (e) {
    console.error('[signal-dispatch] claim failed:', (e as Error).message);
    return json({ error: 'Could not claim the command.' }, 502);
  }

  // Already sent, or never queued. Either way, nothing to do.
  const command = claimed?.[0];
  if (!command) return json({ commandId: id, status: 'not queued' }, 200);

  if (!deps.adapterUrl || !deps.adapterSecret) {
    await record(deps, id, 'FAILED', { reason: 'No signal adapter is configured.' });
    return json({ commandId: id, status: 'FAILED', reason: 'No signal adapter is configured.' }, 200);
  }

  const payload = JSON.stringify(payloadFor(command, deps.maxHoldSeconds));
  const timestamp = String(Math.floor((deps.now ?? Date.now)() / 1000));
  const signature = await signPayload(deps.adapterSecret, timestamp, payload);

  let status: 'ACKNOWLEDGED' | 'REJECTED' | 'FAILED';
  let response: Record<string, unknown>;
  try {
    const res = await deps.fetchImpl(deps.adapterUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SUTRA-Timestamp': timestamp,
        'X-SUTRA-Signature': `v1=${signature}`,
      },
      body: payload,
      signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS),
    });

    const answer = (await res.json().catch(() => ({}))) as {
      status?: string;
      reason?: string;
      controller_ref?: string;
    };

    if (!res.ok) {
      status = 'FAILED';
      response = { http_status: res.status, ...answer };
    } else if (answer.status === 'ACKNOWLEDGED' || answer.status === 'REJECTED') {
      status = answer.status;
      response = answer;
    } else {
      // A 200 that does not say yes or no is not a yes.
      status = 'FAILED';
      response = { reason: 'The controller answered without a status.', answer };
    }
  } catch (e) {
    status = 'FAILED';
    response = { reason: (e as Error).message };
  }

  try {
    await record(deps, id, status, response);
  } catch (e) {
    console.error('[signal-dispatch] could not record the answer:', (e as Error).message);
  }
  return json({ commandId: id, status, response }, 200);
}
