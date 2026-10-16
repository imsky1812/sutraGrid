import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handler,
  photonLabel,
  DEFAULT_GEOCODER,
  DEFAULT_PHOTON,
  DEFAULT_USER_AGENT,
} from '../functions/geocode/handler.ts';

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

// --- Photon first, Nominatim as the fallback ----------------------------------
//
// From the Edge runtime Nominatim answers every request with 403, which left
// the app's place search failing on every query.

const both = (fetchImpl) => ({ ...deps(fetchImpl), photonUrl: 'https://photon.example.com' });

const STATION = {
  type: 'Feature',
  properties: { name: 'Ghaziabad Junction', street: 'Railway Road', city: 'Ghaziabad', state: 'Uttar Pradesh' },
  geometry: { type: 'Point', coordinates: [77.4282, 28.6528] },
};
const photon = (features) => Promise.resolve(new Response(JSON.stringify({ type: 'FeatureCollection', features }), { status: 200 }));
const status = (code) => Promise.resolve(new Response('denied', { status: code }));

test('asks Photon first, and reads its GeoJSON (longitude first)', async () => {
  const calls = [];
  const res = await handler(post({ query: 'railway station' }), both((url) => {
    calls.push(url);
    return photon([STATION]);
  }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/photon\.example\.com\/api\//);
  assert.equal(body.places[0].name, 'Ghaziabad Junction, Railway Road, Ghaziabad, Uttar Pradesh');
  assert.equal(body.places[0].latitude, 28.6528);
  assert.equal(body.places[0].longitude, 77.4282);
});

test('biases Photon toward the driver', async () => {
  let calledUrl = null;
  await handler(post({ query: 'hospital', near: { latitude: 28.63, longitude: 77.44 } }), both((url) => {
    calledUrl = url;
    return photon([STATION]);
  }));
  const params = new URL(calledUrl).searchParams;
  assert.equal(params.get('lat'), '28.63');
  assert.equal(params.get('lon'), '77.44');
});

test('reverse lookups use Photon\'s reverse endpoint', async () => {
  let calledUrl = null;
  const res = await handler(post({ reverse: { latitude: 28.63, longitude: 77.44 } }), both((url) => {
    calledUrl = url;
    return photon([STATION]);
  }));
  assert.match(calledUrl, /photon\.example\.com\/reverse\?/);
  assert.equal((await res.json()).places.length, 1);
});

test('falls back to Nominatim when Photon refuses', async () => {
  const calls = [];
  const res = await handler(post({ query: 'hospital' }), both((url) => {
    calls.push(url);
    return url.includes('photon') ? status(503) : results([HIT])();
  }));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.equal((await res.json()).places[0].name, 'City General Hospital, Bengaluru');
});

test('falls back when Photon cannot be reached at all', async () => {
  const res = await handler(post({ query: 'hospital' }), both((url) =>
    url.includes('photon') ? Promise.reject(new Error('down')) : results([HIT])(),
  ));
  assert.equal(res.status, 200);
});

// The bug as it was seen: Nominatim 403 on every call. With Photon working the
// search succeeds and Nominatim is never asked.
test('a Nominatim 403 no longer breaks search', async () => {
  const res = await handler(post({ query: 'hospital' }), both((url) =>
    url.includes('photon') ? photon([STATION]) : status(403),
  ));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).places.length, 1);
});

test('reports the last error when every provider fails', async () => {
  const res = await handler(post({ query: 'hospital' }), both(() => status(403)));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /403/);
});

// No matches is an answer, not a failure worth a second provider.
test('an empty Photon answer is returned as is', async () => {
  let calls = 0;
  const res = await handler(post({ query: 'zzzzzz' }), both(() => {
    calls += 1;
    return photon([]);
  }));
  assert.equal(calls, 1);
  assert.deepEqual((await res.json()).places, []);
});

test('Photon entries without a name or coordinates are dropped', async () => {
  const res = await handler(post({ query: 'hospital' }), both(() =>
    photon([STATION, { properties: {}, geometry: { coordinates: [77, 28] } }, { properties: { name: 'X' } }]),
  ));
  assert.equal((await res.json()).places.length, 1);
});

test('labels skip empty and repeated parts', () => {
  assert.equal(photonLabel({ name: 'Ghaziabad', city: 'Ghaziabad', state: 'Uttar Pradesh' }), 'Ghaziabad, Uttar Pradesh');
  assert.equal(photonLabel({ housenumber: '12', street: 'MG Road', city: 'Bengaluru' }), '12 MG Road, Bengaluru');
  assert.match(DEFAULT_PHOTON, /^https:\/\//);
});
