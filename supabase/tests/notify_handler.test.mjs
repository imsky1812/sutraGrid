// The function that turns a new alert into push notifications.
//
// It takes only an alert id from the request and gets everything else from the
// database, so most of what can go wrong is on the far side: Expo refusing,
// timing out, or reporting a phone that has uninstalled the app.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  handler,
  messagesFor,
  tagFor,
  titleFor,
  ALERT_CHANNEL,
  BATCH,
} from '../functions/notify/handler.ts';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const tok = (n) => `ExponentPushToken[device${String(n).padStart(12, '0')}]`;

const claimed = (overrides = {}) => ({
  alert_id: 42,
  category: 'EMERGENCY',
  severity: 'CRITICAL',
  message: 'Emergency vehicle behind you. Keep left and give way.',
  expires_at: new Date(NOW + 5 * 60_000).toISOString(),
  tokens: [tok(1)],
  ...overrides,
});

const post = (body) =>
  new Request('http://localhost/notify', { method: 'POST', body: JSON.stringify(body) });

const ok = (payload) => new Response(JSON.stringify(payload), { status: 200 });

/**
 * A fake of both upstreams: PostgREST for the two RPCs, and Expo's push API.
 * Records every call so tests can assert on what was sent where.
 */
function fake({ claim = [claimed()], push = null } = {}) {
  const calls = { claim: [], push: [], forget: [] };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/rpc/claim_alert_push')) {
      calls.claim.push({ body, headers: init.headers });
      return ok(claim);
    }
    if (url.endsWith('/rpc/forget_push_tokens')) {
      calls.forget.push(body);
      return ok(body.p_tokens.length);
    }
    calls.push.push(body);
    if (push) return push(body, calls.push.length);
    return ok({ data: body.map(() => ({ status: 'ok', id: 'ticket' })) });
  };
  return {
    calls,
    deps: {
      supabaseUrl: 'https://db.example.com',
      serviceKey: 'service-key',
      pushUrl: 'https://push.example.com/send',
      fetchImpl,
      sleep: async () => {},
      now: () => NOW,
    },
  };
}

test('rejects a body without a usable alert id', async () => {
  for (const body of [{}, { alert_id: 'x' }, { alert_id: -1 }, { alert_id: 1.5 }]) {
    const { deps, calls } = fake();
    const res = await handler(post(body), deps);
    assert.equal(res.status, 400);
    assert.equal(calls.claim.length, 0);
  }
});

test('rejects malformed JSON without throwing', async () => {
  const { deps } = fake();
  const req = new Request('http://localhost/notify', { method: 'POST', body: '{nope' });
  assert.equal((await handler(req, deps)).status, 400);
});

// The id is the only thing taken from the request. Everything else - text,
// recipients - comes from the database, under the service key.
test('claims the alert with the service key, not the caller', async () => {
  const { deps, calls } = fake();
  await handler(post({ alert_id: 42 }), deps);
  assert.deepEqual(calls.claim[0].body, { p_alert_id: 42 });
  assert.equal(calls.claim[0].headers.Authorization, 'Bearer service-key');
});

test('pushes to every device the database named', async () => {
  const { deps, calls } = fake({ claim: [claimed({ tokens: [tok(1), tok(2)] })] });
  const res = await handler(post({ alert_id: 42 }), deps);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.sent, 2);
  assert.deepEqual(calls.push[0].map((m) => m.to), [tok(1), tok(2)]);
});

// A replayed request, or one for an alert already pushed, must cost nothing.
test('an alert already claimed sends nothing', async () => {
  const { deps, calls } = fake({ claim: [] });
  const res = await handler(post({ alert_id: 42 }), deps);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).sent, 0);
  assert.equal(calls.push.length, 0);
});

test('an alert with nobody to tell sends nothing', async () => {
  const { deps, calls } = fake({ claim: [claimed({ tokens: [] })] });
  await handler(post({ alert_id: 42 }), deps);
  assert.equal(calls.push.length, 0);
});

describe('the message', () => {
  const [m] = messagesFor(claimed(), NOW);

  // Without this exact channel Android shows nothing: Expo's docs are explicit
  // that a channel id the app has not created means no notification at all.
  test('uses the app’s own alert channel', () => {
    assert.equal(m.channelId, ALERT_CHANNEL);
    assert.equal(ALERT_CHANNEL, 'sutra-alerts-v1');
  });

  // Normal priority does not wake a phone in doze.
  test('is high priority', () => assert.equal(m.priority, 'high'));

  test('carries the same tag the app uses, so the two collapse into one', () => {
    assert.equal(m.tag, tagFor(42));
    assert.equal(m.tag, 'sutra-alert-42');
  });

  // A give-way warning delivered after the ambulance has passed is wrong.
  test('expires when the alert does', () => {
    assert.equal(m.ttl, 300);
    const [late] = messagesFor(claimed({ expires_at: new Date(NOW - 1000).toISOString() }), NOW);
    assert.equal(late.ttl, 30);
  });

  test('carries the alert id for the app to match it', () => {
    assert.deepEqual(m.data, { alertId: 42, category: 'EMERGENCY' });
  });

  test('reads the way the app’s own notification does', () => {
    assert.equal(titleFor(claimed()), '🚑 URGENT: Emergency vehicle approaching');
    assert.equal(
      titleFor({ category: 'RULE', severity: 'WARNING', message: 'Overspeeding: 95 km/h in a 80 km/h zone.' }),
      '⚠️ Overspeeding',
    );
    assert.equal(m.body, claimed().message);
  });
});

test('splits large fleets into batches of a hundred', async () => {
  const tokens = Array.from({ length: 250 }, (_, i) => tok(i));
  const { deps, calls } = fake({ claim: [claimed({ tokens })] });
  const body = await (await handler(post({ alert_id: 42 }), deps)).json();
  assert.deepEqual(calls.push.map((b) => b.length), [BATCH, BATCH, 50]);
  assert.equal(body.sent, 250);
});

// Expo documents these as temporary and asks for a retry.
test('retries once when the push service is briefly unavailable', async () => {
  const { deps, calls } = fake({
    push: (body, n) =>
      n === 1
        ? new Response('busy', { status: 503 })
        : ok({ data: body.map(() => ({ status: 'ok' })) }),
  });
  const res = await handler(post({ alert_id: 42 }), deps);
  assert.equal(res.status, 200);
  assert.equal(calls.push.length, 2);
});

test('does not retry a payload the push service rejected', async () => {
  const { deps, calls } = fake({ push: () => new Response('bad', { status: 400 }) });
  const res = await handler(post({ alert_id: 42 }), deps);
  assert.equal(res.status, 502);
  assert.equal(calls.push.length, 1);
});

test('gives up after the second failure and says so', async () => {
  const { deps, calls } = fake({ push: () => new Response('down', { status: 500 }) });
  const res = await handler(post({ alert_id: 42 }), deps);
  assert.equal(res.status, 502);
  assert.equal(calls.push.length, 2);
  assert.match((await res.json()).errors[0], /500/);
});

test('forgets a phone that has uninstalled the app', async () => {
  const { deps, calls } = fake({
    claim: [claimed({ tokens: [tok(1), tok(2), tok(3)] })],
    push: () =>
      ok({
        data: [
          { status: 'ok' },
          { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
          { status: 'ok' },
        ],
      }),
  });
  const body = await (await handler(post({ alert_id: 42 }), deps)).json();
  assert.deepEqual(calls.forget, [{ p_tokens: [tok(2)] }]);
  assert.equal(body.sent, 2);
  assert.equal(body.forgotten, 1);
});

// This is what an unconfigured Firebase key looks like. It must be visible in
// the response, not swallowed.
test('reports credential problems rather than pretending to succeed', async () => {
  const { deps } = fake({
    push: (b) =>
      ok({ data: b.map(() => ({ status: 'error', details: { error: 'InvalidCredentials' } })) }),
  });
  const res = await handler(post({ alert_id: 42 }), deps);
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.deepEqual(body.errors, ['InvalidCredentials']);
  assert.equal(body.sent, 0);
});

test('a claim failure is reported, and nothing is pushed', async () => {
  const { deps, calls } = fake();
  deps.fetchImpl = async (url) =>
    url.includes('/rpc/') ? new Response('nope', { status: 500 }) : ok({ data: [] });
  const res = await handler(post({ alert_id: 42 }), deps);
  assert.equal(res.status, 502);
  assert.equal(calls.push.length, 0);
});
