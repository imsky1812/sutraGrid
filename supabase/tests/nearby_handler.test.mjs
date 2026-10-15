// The nearest emergency service to the driver.
//
// This exists because the app shipped with three hardcoded Bengaluru
// coordinates, so a driver in Delhi who tapped "police" was routed 2,000 km.
// The cases below are the ones that bug could hide behind: a dead Overpass
// mirror, an empty radius, a building mapped as a way rather than a node.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handler, distanceM, nearest, KINDS, RADII_M } from '../functions/nearby/handler.ts';

const DELHI = { latitude: 28.6139, longitude: 77.209 };

const deps = (fetchImpl, overpassUrls = ['https://a.example.com', 'https://b.example.com']) => ({
  overpassUrls,
  geocoderUrl: 'https://geo.example.com',
  userAgent: 'test-agent',
  fetchImpl,
});

const post = (body) =>
  new Request('http://localhost/nearby', { method: 'POST', body: JSON.stringify(body) });

const ok = (payload) => new Response(JSON.stringify(payload), { status: 200 });
const never = () => Promise.reject(new Error('upstream should not have been called'));

/** A node, as Overpass returns a small police post. */
const node = (id, lat, lon, name) => ({ type: 'node', id, lat, lon, tags: name ? { name } : {} });
/** A way with `out center`, as Overpass returns a hospital's building outline. */
const way = (id, lat, lon, name) => ({ type: 'way', id, center: { lat, lon }, tags: { name } });

const isOverpass = (url) => url.startsWith('https://a.') || url.startsWith('https://b.');

test('rejects an unknown kind', async () => {
  const res = await handler(post({ kind: 'bakery', near: DELHI }), deps(never));
  assert.equal(res.status, 400);
});

test('rejects a missing or out-of-range location', async () => {
  for (const near of [undefined, { latitude: 91, longitude: 0 }, { latitude: 0 }]) {
    const res = await handler(post({ kind: 'hospital', near }), deps(never));
    assert.equal(res.status, 400);
  }
});

test('rejects malformed JSON without throwing', async () => {
  const req = new Request('http://localhost/nearby', { method: 'POST', body: '{not json' });
  const res = await handler(req, deps(never));
  assert.equal(res.status, 400);
});

test('returns the nearest service, closest first', async () => {
  const res = await handler(
    post({ kind: 'hospital', near: DELHI }),
    deps(() =>
      Promise.resolve(
        ok({
          elements: [
            node(1, 28.68, 77.209, 'Far Hospital'),
            way(2, 28.62, 77.209, 'Near Hospital'),
          ],
        }),
      ),
    ),
  );

  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.source, 'overpass');
  assert.deepEqual(
    body.places.map((p) => p.name),
    ['Near Hospital', 'Far Hospital'],
  );
  // The whole point: it is near the driver, not in another city.
  assert.ok(body.places[0].distanceMeters < 1000);
});

// A hospital is mapped as a building outline far more often than as a point.
test('reads a way through its center', async () => {
  const res = await handler(
    post({ kind: 'hospital', near: DELHI }),
    deps(() => Promise.resolve(ok({ elements: [way(2, 28.62, 77.21, 'AIIMS')] }))),
  );
  const body = await res.json();
  assert.equal(body.places[0].latitude, 28.62);
  assert.equal(body.places[0].longitude, 77.21);
});

test('an unnamed node still gets a usable label', async () => {
  const res = await handler(
    post({ kind: 'police', near: DELHI }),
    deps(() => Promise.resolve(ok({ elements: [node(3, 28.615, 77.21, null)] }))),
  );
  const body = await res.json();
  assert.equal(body.places[0].name, KINDS.police.label);
});

test('falls through to the second mirror when the first refuses', async () => {
  const seen = [];
  const res = await handler(
    post({ kind: 'fire', near: DELHI }),
    deps((url) => {
      seen.push(url);
      if (url.startsWith('https://a.')) return Promise.resolve(new Response('', { status: 406 }));
      return Promise.resolve(ok({ elements: [node(4, 28.615, 77.21, 'Fire Station 1')] }));
    }),
  );

  assert.equal((await res.json()).places[0].name, 'Fire Station 1');
  assert.deepEqual(seen, ['https://a.example.com', 'https://b.example.com']);
});

test('widens the radius when nothing is found close by', async () => {
  const radii = [];
  const res = await handler(
    post({ kind: 'hospital', near: DELHI }),
    deps((url, init) => {
      radii.push(Number(/around%3A(\d+)/.exec(init.body)[1]));
      // Empty until the widest search.
      const found = radii.length >= RADII_M.length;
      return Promise.resolve(ok({ elements: found ? [node(5, 28.9, 77.3, 'District Hospital')] : [] }));
    }),
  );

  assert.deepEqual(radii, RADII_M);
  assert.equal((await res.json()).places[0].name, 'District Hospital');
});

// An empty answer from a working server is an answer. A dead server is not,
// and the two must not be confused: one means "nothing here", the other means
// "ask somewhere else".
test('an empty Overpass answer still tries the geocoder', async () => {
  let geocoded = false;
  const res = await handler(
    post({ kind: 'hospital', near: DELHI }),
    deps((url) => {
      if (isOverpass(url)) return Promise.resolve(ok({ elements: [] }));
      geocoded = true;
      return Promise.resolve(ok([{ display_name: 'Rural Hospital', lat: '28.9', lon: '77.3' }]));
    }),
  );

  assert.ok(geocoded);
  const body = await res.json();
  assert.equal(body.source, 'nominatim');
  assert.equal(body.places[0].name, 'Rural Hospital');
});

test('the geocoder search is bounded to the driver, not merely biased', async () => {
  let searchUrl = '';
  await handler(
    post({ kind: 'police', near: DELHI }),
    deps((url) => {
      if (isOverpass(url)) return Promise.reject(new Error('down'));
      searchUrl = url;
      return Promise.resolve(ok([{ display_name: 'Thana', lat: '28.62', lon: '77.21' }]));
    }),
  );

  const params = new URL(searchUrl).searchParams;
  assert.equal(params.get('bounded'), '1');
  assert.ok(params.get('viewbox').includes('77.'));
});

test('reports a genuine empty area rather than inventing a destination', async () => {
  const res = await handler(
    post({ kind: 'fire', near: DELHI }),
    deps((url) => (isOverpass(url) ? Promise.resolve(ok({ elements: [] })) : Promise.resolve(ok([])))),
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.places, []);
});

test('reports failure when every provider is down', async () => {
  const res = await handler(post({ kind: 'hospital', near: DELHI }), deps(() => Promise.reject(new Error('down'))));
  assert.equal(res.status, 502);
  assert.ok((await res.json()).error.includes('hospital'));
});

test('sends the headers overpass-api.de requires', async () => {
  let headers = null;
  await handler(
    post({ kind: 'hospital', near: DELHI }),
    deps((url, init) => {
      headers = init.headers;
      return Promise.resolve(ok({ elements: [node(6, 28.62, 77.21, 'X')] }));
    }),
  );

  assert.equal(headers.Accept, 'application/json');
  assert.equal(headers['User-Agent'], 'test-agent');
});

test('caps the number of results', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `H${i}`, latitude: 0, longitude: 0, distanceMeters: i }));
  assert.equal(nearest(many).length, 5);
});

test('distance matches the database approximation', async () => {
  // One degree of latitude, as the planar formula defines it.
  assert.equal(Math.round(distanceM([0, 0], [1, 0])), 110540);
});
