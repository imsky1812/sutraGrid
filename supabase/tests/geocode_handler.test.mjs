import test from 'node:test';
import assert from 'node:assert/strict';
import { handler, DEFAULT_GEOCODER, DEFAULT_USER_AGENT } from '../functions/geocode/handler.ts';

const deps = (fetchImpl) => ({
  geocoderUrl: 'https://geo.example.com',
  userAgent: 'test-agent',
  fetchImpl,
});

const post = (body) =>
  new Request('http://localhost/geocode', { method: 'POST', body: JSON.stringify(body) });

const results = (rows) => () =>
  Promise.resolve(new Response(JSON.stringify(rows), { status: 200 }));

const never = () => Promise.reject(new Error('upstream should not have been called'));

const HIT = { display_name: 'City General Hospital, Bengaluru', lat: '12.976', lon: '77.601' };

test('rejects a query shorter than three characters', async () => {
  const res = await handler(post({ query: 'ho' }), deps(never));
  assert.equal(res.status, 400);
});

test('rejects a body with neither query nor reverse', async () => {
  const res = await handler(post({}), deps(never));
  assert.equal(res.status, 400);
});

test('rejects malformed JSON without throwing', async () => {
  const req = new Request('http://localhost/geocode', { method: 'POST', body: '{not json' });
  const res = await handler(req, deps(never));
  assert.equal(res.status, 400);
});

test('returns places for a search', async () => {
  const res = await handler(post({ query: 'hospital' }), deps(results([HIT])));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.places.length, 1);
  assert.equal(body.places[0].name, 'City General Hospital, Bengaluru');
  assert.equal(body.places[0].latitude, 12.976);
});

// Nominatim asks for a genuine User-Agent; without one it rate-limits or blocks.
test('identifies itself with a User-Agent', async () => {
  let seen = null;
  await handler(post({ query: 'hospital' }), deps((url, init) => {
    seen = init;
    return results([HIT])();
  }));
  assert.equal(seen.headers['User-Agent'], 'test-agent');
});

test('biases search results toward the driver', async () => {
  let calledUrl = null;
  await handler(
    post({ query: 'hospital', near: { latitude: 12.97, longitude: 77.59 } }),
    deps((url) => {
      calledUrl = url;
      return results([HIT])();
    }),
  );
  assert.ok(new URL(calledUrl).searchParams.get('viewbox'), 'viewbox is set');
});

test('omits the bias when no position is known', async () => {
  let calledUrl = null;
  await handler(post({ query: 'hospital' }), deps((url) => {
    calledUrl = url;
    return results([HIT])();
  }));
  assert.equal(new URL(calledUrl).searchParams.get('viewbox'), null);
});

// Reverse returns a single object rather than an array.
test('handles a reverse lookup', async () => {
  const res = await handler(
    post({ reverse: { latitude: 12.976, longitude: 77.601 } }),
    deps(() => Promise.resolve(new Response(JSON.stringify(HIT), { status: 200 }))),
  );
  const body = await res.json();
  assert.equal(body.places[0].name, 'City General Hospital, Bengaluru');
});

test('calls the reverse endpoint for a reverse lookup', async () => {
  let calledUrl = null;
  await handler(
    post({ reverse: { latitude: 12.976, longitude: 77.601 } }),
    deps((url) => {
      calledUrl = url;
      return Promise.resolve(new Response(JSON.stringify(HIT), { status: 200 }));
    }),
  );
  assert.match(calledUrl, /\/reverse\?/);
});

test('rejects an out-of-range reverse coordinate', async () => {
  const res = await handler(post({ reverse: { latitude: 999, longitude: 0 } }), deps(never));
  assert.equal(res.status, 400);
});

// A result missing coordinates would put a marker at 0,0.
test('drops entries without usable coordinates', async () => {
  const res = await handler(
    post({ query: 'hospital' }),
    deps(results([HIT, { display_name: 'Broken', lat: 'x', lon: 'y' }])),
  );
  assert.equal((await res.json()).places.length, 1);
});

test('caps how many results are returned', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...HIT, display_name: `Place ${i}` }));
  const res = await handler(post({ query: 'hospital' }), deps(results(many)));
  assert.equal((await res.json()).places.length, 8);
});

test('survives an upstream network error', async () => {
  const res = await handler(post({ query: 'hospital' }), deps(() => Promise.reject(new Error('x'))));
  assert.equal(res.status, 502);
});

test('survives an unreadable upstream response', async () => {
  const res = await handler(
    post({ query: 'hospital' }),
    deps(() => Promise.resolve(new Response('<html>', { status: 200 }))),
  );
  assert.equal(res.status, 502);
});

test('exposes sane defaults', () => {
  assert.match(DEFAULT_GEOCODER, /^https:\/\//);
  assert.ok(DEFAULT_USER_AGENT.length > 0);
});
