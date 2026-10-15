// Delivering a signal command to a city's controller.
//
// These run the real dispatch handler against the reference city-side
// adapter (tools/mock-signal-adapter.mjs) over real HTTP, so the two sides of
// the contract are checked against each other - signature included - rather
// than each against its own idea of it.

import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { handler, payloadFor, signPayload } from '../functions/signal-dispatch/handler.ts';
import { createAdapter, verify, decide } from '../../tools/mock-signal-adapter.mjs';

const SECRET = 'shared-with-the-city';

const COMMAND = {
  id: 42,
  corridor_id: '7d1c2a10-0000-4000-8000-000000000000',
  osm_id: 1000,
  lat: 12.9754,
  lng: 77.59,
  command: 'PREEMPT',
  eta_s: 45,
  approach_deg: 0,
  vehicle_type: 'AMBULANCE',
  issued_at: '2026-10-16T09:00:00Z',
};

// The reference adapter, on a random free port.
const logs = [];
const server = createAdapter({ secret: SECRET, reject: new Set(['999']), log: (l) => logs.push(l) });
await new Promise((r) => server.listen(0, r));
const ADAPTER_URL = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

/** PostgREST is faked; the adapter is real. */
function deps({ claim = [COMMAND], adapterUrl = ADAPTER_URL, adapterSecret = SECRET } = {}) {
  const recorded = [];
  return {
    recorded,
    deps: {
      supabaseUrl: 'https://db.example.com',
      serviceKey: 'service-key',
      adapterUrl,
      adapterSecret,
      maxHoldSeconds: 120,
      fetchImpl: async (url, init) => {
        if (url.endsWith('/rpc/claim_signal_command')) return new Response(JSON.stringify(claim));
        if (url.endsWith('/rpc/record_signal_response')) {
          recorded.push(JSON.parse(init.body));
          return new Response('');
        }
        return fetch(url, init);
      },
    },
  };
}

const post = (body) => new Request('http://localhost/signal-dispatch', { method: 'POST', body: JSON.stringify(body) });

describe('end to end with the reference adapter', () => {
  test('a pre-emption is signed, accepted, and the answer recorded', async () => {
    const { deps: d, recorded } = deps();
    const res = await handler(post({ command_id: 42 }), d);
    const body = await res.json();
    assert.equal(body.status, 'ACKNOWLEDGED');
    assert.deepEqual(recorded, [
      { p_command_id: 42, p_status: 'ACKNOWLEDGED', p_response: { status: 'ACKNOWLEDGED', controller_ref: 'mock-42' } },
    ]);
    assert.match(logs.at(-1), /PREEMPT junction 1000 eta 45s -> ACKNOWLEDGED/);
  });

  test('a city refusal is recorded with its reason, not treated as success', async () => {
    const { deps: d, recorded } = deps({ claim: [{ ...COMMAND, osm_id: 999 }] });
    await handler(post({ command_id: 42 }), d);
    assert.equal(recorded[0].p_status, 'REJECTED');
    assert.equal(recorded[0].p_response.reason, 'Junction is under manual control.');
  });

  // The city must be able to tell SUTRA from anyone who knows its address.
  test('a wrong secret is refused by the city', async () => {
    const { deps: d, recorded } = deps({ adapterSecret: 'not-the-secret' });
    await handler(post({ command_id: 42 }), d);
    assert.equal(recorded[0].p_status, 'FAILED');
    assert.equal(recorded[0].p_response.http_status, 401);
  });
});

describe('when things go wrong', () => {
  test('with no adapter configured, nothing is sent and it says so', async () => {
    const { deps: d, recorded } = deps({ adapterUrl: null });
    const body = await (await handler(post({ command_id: 42 }), d)).json();
    assert.equal(body.status, 'FAILED');
    assert.equal(recorded[0].p_response.reason, 'No signal adapter is configured.');
  });

  test('an unreachable controller is a failure, recorded', async () => {
    const { deps: d, recorded } = deps({ adapterUrl: 'http://127.0.0.1:1' });
    await handler(post({ command_id: 42 }), d);
    assert.equal(recorded[0].p_status, 'FAILED');
  });

  test('a command already sent is not sent again', async () => {
    const { deps: d, recorded } = deps({ claim: [] });
    const body = await (await handler(post({ command_id: 42 }), d)).json();
    assert.equal(body.status, 'not queued');
    assert.deepEqual(recorded, []);
  });

  test('a body without a usable id is refused', async () => {
    for (const b of [{}, { command_id: 'x' }, { command_id: -3 }]) {
      assert.equal((await handler(post(b), deps().deps)).status, 400);
    }
  });
});

describe('the contract', () => {
  test('carries what a controller needs, including how long it may hold', () => {
    assert.deepEqual(payloadFor(COMMAND, 120), {
      version: 1,
      command_id: 42,
      command: 'PREEMPT',
      issued_at: '2026-10-16T09:00:00Z',
      junction: { osm_id: 1000, lat: 12.9754, lng: 77.59 },
      approach_bearing_deg: 0,
      eta_seconds: 45,
      vehicle_type: 'AMBULANCE',
      corridor_id: COMMAND.corridor_id,
      max_hold_seconds: 120,
    });
  });

  test('the two sides agree on the signature', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await signPayload(SECRET, ts, '{"a":1}');
    assert.equal(verify(SECRET, ts, '{"a":1}', `v1=${sig}`), true);
    assert.equal(verify(SECRET, ts, '{"a":2}', `v1=${sig}`), false, 'a changed body fails');
  });

  // A captured request must not be replayable later.
  test('an old request is refused even with a valid signature', async () => {
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    const sig = await signPayload(SECRET, old, '{}');
    assert.equal(verify(SECRET, old, '{}', `v1=${sig}`), false);
  });

  test('releasing a junction is always accepted', () => {
    const release = { ...payloadFor({ ...COMMAND, command: 'RELEASE', osm_id: 999 }, 120) };
    assert.equal(decide(release, { reject: new Set(['999']) }).status, 'ACKNOWLEDGED');
  });
});
