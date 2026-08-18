// Tests the Directions Edge Function's request handler.
//
// The handler is deliberately free of Deno globals so it can run here under
// Node's native type stripping. index.ts holds the Deno.serve/Deno.env wiring,
// which is six lines and has nothing to assert.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../functions/directions/handler.ts';

const post = (body) =>
  new Request('http://localhost/directions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const okUpstream = (points = '_p~iF~ps|U') => () =>
  Promise.resolve(
    new Response(JSON.stringify({ status: 'OK', routes: [{ overview_polyline: { points } }] })),
  );

const never = () => Promise.reject(new Error('upstream should not have been called'));

test('rejects a request with no origin', async () => {
  const res = await handler(post({ destination: { latitude: 1, longitude: 2 } }), {
    apiKey: 'test-key',
    fetchImpl: never,
  });
  assert.equal(res.status, 400);
});

test('rejects a request with no destination', async () => {
  const res = await handler(post({ origin: { latitude: 1, longitude: 2 } }), {
    apiKey: 'test-key',
    fetchImpl: never,
  });
  assert.equal(res.status, 400);
});

test('rejects non-numeric coordinates', async () => {
  const res = await handler(
    post({ origin: { latitude: 'north', longitude: 2 }, destination: { latitude: 3, longitude: 4 } }),
    { apiKey: 'test-key', fetchImpl: never },
  );
  assert.equal(res.status, 400);
});

test('rejects out-of-range coordinates', async () => {
  const res = await handler(
    post({ origin: { latitude: 999, longitude: 2 }, destination: { latitude: 3, longitude: 4 } }),
    { apiKey: 'test-key', fetchImpl: never },
  );
  assert.equal(res.status, 400);
});

test('rejects malformed JSON without throwing', async () => {
  const res = await handler(post('{not json'), { apiKey: 'test-key', fetchImpl: never });
  assert.equal(res.status, 400);
});

test('fails closed when no API key is configured', async () => {
  const res = await handler(
    post({ origin: { latitude: 1, longitude: 2 }, destination: { latitude: 3, longitude: 4 } }),
    { apiKey: '', fetchImpl: never },
  );
  assert.equal(res.status, 500);
});

test('returns the overview polyline on success', async () => {
  const res = await handler(
    post({ origin: { latitude: 1, longitude: 2 }, destination: { latitude: 3, longitude: 4 } }),
    { apiKey: 'test-key', fetchImpl: okUpstream() },
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).polyline, '_p~iF~ps|U');
});

test('sends origin, destination and driving mode upstream', async () => {
  let called = null;
  const fetchImpl = (url) => {
    called = new URL(url);
    return okUpstream()();
  };

  await handler(
    post({ origin: { latitude: 12.97, longitude: 77.59 }, destination: { latitude: 13.0, longitude: 77.6 } }),
    { apiKey: 'test-key', fetchImpl },
  );

  assert.equal(called.searchParams.get('origin'), '12.97,77.59');
  assert.equal(called.searchParams.get('destination'), '13,77.6');
  assert.equal(called.searchParams.get('mode'), 'driving');
});

test('reports an upstream failure as 502', async () => {
  const fetchImpl = () => Promise.resolve(new Response(JSON.stringify({ status: 'ZERO_RESULTS' })));
  const res = await handler(
    post({ origin: { latitude: 1, longitude: 2 }, destination: { latitude: 3, longitude: 4 } }),
    { apiKey: 'test-key', fetchImpl },
  );
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /ZERO_RESULTS/);
});

test('survives an upstream network error', async () => {
  const fetchImpl = () => Promise.reject(new Error('ECONNRESET'));
  const res = await handler(
    post({ origin: { latitude: 1, longitude: 2 }, destination: { latitude: 3, longitude: 4 } }),
    { apiKey: 'test-key', fetchImpl },
  );
  assert.equal(res.status, 502);
});

// The whole point of this function is that the key stays server-side. If it
// ever reaches a response body, the proxy is pointless.
test('never leaks the API key into a response', async () => {
  const SECRET = 'super-secret-key-value';
  const cases = [
    { fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ status: 'REQUEST_DENIED' }))) },
    { fetchImpl: () => Promise.reject(new Error(`failed calling https://maps.googleapis.com/?key=${SECRET}`)) },
    { fetchImpl: okUpstream() },
  ];

  for (const { fetchImpl } of cases) {
    const res = await handler(
      post({ origin: { latitude: 1, longitude: 2 }, destination: { latitude: 3, longitude: 4 } }),
      { apiKey: SECRET, fetchImpl },
    );
    const body = await res.text();
    assert.equal(body.includes(SECRET), false, `key leaked in: ${body}`);
  }
});
