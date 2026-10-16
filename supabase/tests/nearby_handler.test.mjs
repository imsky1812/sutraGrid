// The nearest emergency service to the driver.
//
// This exists because the app shipped with three hardcoded Bengaluru
// coordinates, so a driver in Delhi who tapped "police" was routed 2,000 km.
// The cases below are the ones that bug could hide behind: a dead Overpass
// mirror, an empty radius, a building mapped as a way rather than a node.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handler,
  bboxAround,
  distanceM,
  nearest,
  KINDS,
  RADII_M,
  DEFAULT_PHOTON,
} from '../functions/nearby/handler.ts';

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

// --- Photon first ------------------------------------------------------------
//
// On 16 October every public Overpass server was refusing or timing out and
// Nominatim refuses the Edge runtime, so the Nearest buttons failed every time.
// Photon lists amenities by category inside a box, whatever they are called.

const withPhoton = (fetchImpl) => ({ ...deps(fetchImpl), photonUrl: 'https://photon.example.com' });
const isPhoton = (url) => url.startsWith('https://photon.');
const feature = (lat, lon, name) => ({
  type: 'Feature',
  properties: name ? { name } : {},
  geometry: { type: 'Point', coordinates: [lon, lat] },
});
const features = (list) => ok({ type: 'FeatureCollection', features: list });

test('asks Photon by category inside a box, and returns the nearest first', async () => {
  const calls = [];
  const res = await handler(post({ kind: 'hospital', near: DELHI }), withPhoton((url) => {
    calls.push(url);
    return Promise.resolve(features([
      feature(DELHI.latitude + 0.03, DELHI.longitude, 'Far Hospital'),
      feature(DELHI.latitude + 0.005, DELHI.longitude, 'Dr Rupali Gupta'),
    ]));
  }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.source, 'photon');
  assert.equal(calls.length, 1);
  const params = new URL(calls[0]).searchParams;
  assert.equal(params.get('include'), 'osm.amenity.hospital');
  assert.ok(params.get('bbox'));
  // A hospital need not be called one.
  assert.equal(body.places[0].name, 'Dr Rupali Gupta');
  assert.ok(body.places[0].distanceMeters < body.places[1].distanceMeters);
});

test('Photon widens the box until something turns up', async () => {
  const boxes = [];
  const res = await handler(post({ kind: 'fire', near: DELHI }), withPhoton((url) => {
    boxes.push(new URL(url).searchParams.get('bbox'));
    return Promise.resolve(
      boxes.length < 2 ? features([]) : features([feature(DELHI.latitude + 0.1, DELHI.longitude, 'Fire Station')]),
    );
  }));
  assert.equal(res.status, 200);
  assert.equal(boxes.length, 2);
  assert.notEqual(boxes[0], boxes[1]);
  assert.equal((await res.json()).places[0].name, 'Fire Station');
});

test('falls back to Overpass when Photon is down', async () => {
  const res = await handler(post({ kind: 'police', near: DELHI }), withPhoton((url) =>
    isPhoton(url)
      ? Promise.resolve(new Response('busy', { status: 503 }))
      : Promise.resolve(ok({ elements: [node(1, DELHI.latitude + 0.01, DELHI.longitude, 'Thana')] })),
  ));
  const body = await res.json();
  assert.equal(body.source, 'overpass');
  assert.equal(body.places[0].name, 'Thana');
});

// The day it broke: Overpass dead everywhere, Nominatim 403.
test('works with every Overpass server down and Nominatim refusing', async () => {
  const res = await handler(post({ kind: 'hospital', near: DELHI }), withPhoton((url) =>
    isPhoton(url)
      ? Promise.resolve(features([feature(DELHI.latitude + 0.01, DELHI.longitude, 'Yashoda Hospital')]))
      : Promise.resolve(new Response('no', { status: isOverpass(url) ? 504 : 403 })),
  ));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).places[0].name, 'Yashoda Hospital');
});

test('an unnamed Photon result is still somewhere to drive to', async () => {
  const res = await handler(post({ kind: 'police', near: DELHI }), withPhoton(() =>
    Promise.resolve(features([feature(DELHI.latitude + 0.01, DELHI.longitude)])),
  ));
  assert.equal((await res.json()).places[0].name, 'Police station');
});

test('the box is centred on the driver and grows with the radius', () => {
  const [w, s, e, n] = bboxAround(DELHI, 5000).split(',').map(Number);
  assert.ok(w < DELHI.longitude && e > DELHI.longitude && s < DELHI.latitude && n > DELHI.latitude);
  assert.ok(Math.abs((n - s) * 110540 - 10000) < 5);
  const wide = bboxAround(DELHI, 15000).split(',').map(Number);
  assert.ok(wide[3] - wide[1] > n - s);
  assert.match(DEFAULT_PHOTON, /^https:\/\//);
});

// --- Google Places, when a key is configured ------------------------------------
//
// OpenStreetMap had no police or fire station within 3 km of a driver in
// Ghaziabad that Google Maps showed within 1-2 km.

const withGoogle = (fetchImpl) => ({
  ...withPhoton(fetchImpl),
  googleKey: 'test-key',
  googleUrl: 'https://google.example.com/places:searchNearby',
});
const isGoogle = (url) => url.startsWith('https://google.');
const gplace = (lat, lng, name) => ({ displayName: { text: name }, location: { latitude: lat, longitude: lng } });

test('with a key, asks Google first, by type and ranked by distance', async () => {
  const calls = [];
  const res = await handler(post({ kind: 'police', near: DELHI }), withGoogle((url, init) => {
    calls.push({ url, init });
    return Promise.resolve(ok({ places: [gplace(DELHI.latitude + 0.009, DELHI.longitude, 'Kotwali Police Station')] }));
  }));
  const body = await res.json();
  assert.equal(body.source, 'google');
  assert.equal(body.places[0].name, 'Kotwali Police Station');
  assert.equal(calls.length, 1);
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent.includedTypes, ['police']);
  assert.equal(sent.rankPreference, 'DISTANCE');
  assert.equal(sent.locationRestriction.circle.radius, RADII_M[0]);
  assert.equal(calls[0].init.headers['X-Goog-Api-Key'], 'test-key');
  // Name and location only: the cheapest fields that answer the question.
  assert.equal(calls[0].init.headers['X-Goog-FieldMask'], 'places.displayName,places.location');
});

test('a refused key falls back to the free sources', async () => {
  const res = await handler(post({ kind: 'hospital', near: DELHI }), withGoogle((url) =>
    isGoogle(url)
      ? Promise.resolve(new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: 403 }))
      : Promise.resolve(features([feature(DELHI.latitude + 0.01, DELHI.longitude, 'OSM Hospital')])),
  ));
  const body = await res.json();
  assert.equal(body.source, 'photon');
  assert.equal(body.places[0].name, 'OSM Hospital');
});

test('Google widens the circle when nothing is close', async () => {
  const radii = [];
  const res = await handler(post({ kind: 'fire', near: DELHI }), withGoogle((url, init) => {
    radii.push(JSON.parse(init.body).locationRestriction.circle.radius);
    return Promise.resolve(ok(radii.length < 2 ? {} : { places: [gplace(DELHI.latitude + 0.1, DELHI.longitude, 'Fire Station')] }));
  }));
  assert.deepEqual(radii, RADII_M.slice(0, 2));
  assert.equal((await res.json()).source, 'google');
});

test('without a key, Google is never called', async () => {
  const res = await handler(post({ kind: 'hospital', near: DELHI }), withPhoton((url) => {
    assert.ok(!isGoogle(url));
    return Promise.resolve(features([feature(DELHI.latitude + 0.01, DELHI.longitude, 'OSM Hospital')]));
  }));
  assert.equal((await res.json()).source, 'photon');
});
