// Tests the routing Edge Function's request handler.
//
// The handler is free of Deno globals so it can run here under Node's native
// type stripping. index.ts holds the Deno.serve/Deno.env wiring, which is a few
// lines and has nothing to assert.
//
// Routing uses OSRM, which needs no API key. There is consequently no
// key-leakage test any more — there is no key to leak.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handler, DEFAULT_ROUTER } from '../functions/directions/handler.ts';

const ROUTER = 'https://router.example.com';

const post = (body) =>
  new Request('http://localhost/directions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const VALID = {
  origin: { latitude: 12.9716, longitude: 77.5946 },
  destination: { latitude: 12.976, longitude: 77.601 },
};

const okUpstream =
  (geometry = '_p~iF~ps|U', extra = {}) =>
  () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ code: 'Ok', routes: [{ geometry, distance: 1404, duration: 210, ...extra }] }),
        { status: 200 },
      ),
    );

const never = () => Promise.reject(new Error('upstream should not have been called'));

const deps = (fetchImpl) => ({ routerUrl: ROUTER, fetchImpl });

test('rejects a request with no origin', async () => {
  const res = await handler(post({ destination: VALID.destination }), deps(never));
  assert.equal(res.status, 400);
});

test('rejects a request with no destination', async () => {
  const res = await handler(post({ origin: VALID.origin }), deps(never));
  assert.equal(res.status, 400);
});

test('rejects non-numeric coordinates', async () => {
  const res = await handler(
    post({ origin: { latitude: 'north', longitude: 2 }, destination: VALID.destination }),
    deps(never),
  );
  assert.equal(res.status, 400);
});

test('rejects out-of-range coordinates', async () => {
  const res = await handler(
    post({ origin: { latitude: 999, longitude: 2 }, destination: VALID.destination }),
    deps(never),
  );
  assert.equal(res.status, 400);
});

test('rejects malformed JSON without throwing', async () => {
  const res = await handler(post('{not json'), deps(never));
  assert.equal(res.status, 400);
});

test('returns the encoded polyline on success', async () => {
  const res = await handler(post(VALID), deps(okUpstream()));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).polyline, '_p~iF~ps|U');
});

test('passes through distance and duration', async () => {
  const res = await handler(post(VALID), deps(okUpstream()));
  const body = await res.json();
  assert.equal(body.distanceMeters, 1404);
  assert.equal(body.durationSeconds, 210);
});

// OSRM takes lon,lat. Reversing it returns a plausible route in the wrong
// hemisphere rather than an error, so this is asserted explicitly.
test('sends coordinates as lon,lat in OSRM order', async () => {
  let calledUrl = null;
  const fetchImpl = (url) => {
    calledUrl = url;
    return okUpstream()();
  };

  await handler(post(VALID), deps(fetchImpl));

  assert.match(calledUrl, /\/route\/v1\/driving\/77\.5946,12\.9716;77\.601,12\.976\?/);
});

test('requests a full-overview polyline geometry', async () => {
  let calledUrl = null;
  const fetchImpl = (url) => {
    calledUrl = url;
    return okUpstream()();
  };

  await handler(post(VALID), deps(fetchImpl));

  const query = new URL(calledUrl).searchParams;
  assert.equal(query.get('overview'), 'full');
  assert.equal(query.get('geometries'), 'polyline');
});

test('uses the configured router rather than a hardcoded host', async () => {
  let calledUrl = null;
  const fetchImpl = (url) => {
    calledUrl = url;
    return okUpstream()();
  };

  await handler(post(VALID), { routerUrl: 'https://osrm.internal', fetchImpl });

  assert.ok(String(calledUrl).startsWith('https://osrm.internal/'));
});

test('exposes a default router for the unconfigured case', () => {
  assert.match(DEFAULT_ROUTER, /^https:\/\//);
});

test('reports a routing failure as 502', async () => {
  const fetchImpl = () =>
    Promise.resolve(new Response(JSON.stringify({ code: 'NoRoute' }), { status: 200 }));

  const res = await handler(post(VALID), deps(fetchImpl));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /NoRoute/);
});

test('reports a missing geometry as NoRoute', async () => {
  const fetchImpl = () =>
    Promise.resolve(new Response(JSON.stringify({ code: 'Ok', routes: [{}] }), { status: 200 }));

  const res = await handler(post(VALID), deps(fetchImpl));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /NoRoute/);
});

// Upstream free text is logged, never returned, so the response contract does
// not drift with the router's wording.
test('does not echo the router free-text message', async () => {
  const fetchImpl = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ code: 'InvalidQuery', message: 'Query string malformed close to position 42' }),
        { status: 400 },
      ),
    );

  const res = await handler(post(VALID), deps(fetchImpl));
  const body = await res.text();
  assert.equal(body.includes('position 42'), false);
  assert.match(body, /InvalidQuery/);
});

test('survives an upstream network error', async () => {
  const res = await handler(post(VALID), deps(() => Promise.reject(new Error('ECONNRESET'))));
  assert.equal(res.status, 502);
});

test('survives an unreadable upstream response', async () => {
  const fetchImpl = () =>
    Promise.resolve(new Response('<html>gateway error</html>', { status: 502 }));
  const res = await handler(post(VALID), deps(fetchImpl));
  assert.equal(res.status, 502);
});
