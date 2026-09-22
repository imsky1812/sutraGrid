// Tests the green-corridor planner's request handler and its geometry helpers.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handler,
  densify,
  distanceM,
  mergeJunctions,
  orderAlongRoute,
  routeLength,
  samplePath,
} from '../functions/corridor/handler.ts';

const post = (body) =>
  new Request('http://localhost/corridor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const VALID = {
  origin: { latitude: 12.97, longitude: 77.59 },
  destination: { latitude: 12.988, longitude: 77.59 },
};

// OSRM geometry in [lng, lat]: a 2 km straight road with only its two ends.
const OSRM_OK = {
  code: 'Ok',
  routes: [{ geometry: { coordinates: [[77.59, 12.97], [77.59, 12.988]] }, distance: 1990, duration: 180 }],
};

const signalAt = (id, lat, lng = 77.59) => ({ type: 'node', id, lat, lon: lng });

/** Routes OSRM and Overpass calls to separate fakes, and records them. */
function upstream({ osrm = OSRM_OK, overpass = { elements: [] }, overpassFails = false, primaryStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://router.test')) {
      return new Response(JSON.stringify(osrm), { status: 200 });
    }
    if (overpassFails) throw new Error('overpass down');
    if (String(url).startsWith('https://overpass.test') && primaryStatus !== 200) {
      return new Response('busy', { status: primaryStatus });
    }
    return new Response(JSON.stringify(overpass), { status: 200 });
  };
  return {
    calls,
    deps: {
      routerUrl: 'https://router.test',
      overpassUrls: ['https://overpass.test/api/interpreter', 'https://mirror.test/api/interpreter'],
      userAgent: 'SUTRA-test',
      fetchImpl,
    },
  };
}

// --- Geometry --------------------------------------------------------------

test('distanceM is close to the true distance over a city block', () => {
  // 0.009 degrees of latitude is about 995 m.
  assert.ok(Math.abs(distanceM([12.97, 77.59], [12.979, 77.59]) - 995) < 2);
});

test('densify leaves no gap wider than the spacing', () => {
  const out = densify([[12.97, 77.59], [12.988, 77.59]], 25);
  for (let i = 1; i < out.length; i++) assert.ok(distanceM(out[i - 1], out[i]) <= 25.001);
  assert.deepEqual(out[0], [12.97, 77.59]);
  assert.deepEqual(out.at(-1), [12.988, 77.59]);
});

test('densify keeps the total length', () => {
  const route = [[12.97, 77.59], [12.98, 77.6], [12.99, 77.6]];
  assert.ok(Math.abs(routeLength(densify(route, 25)) - routeLength(route)) < 1);
});

test('samplePath caps the point count and keeps both ends', () => {
  const route = Array.from({ length: 1000 }, (_, i) => [12.97 + i * 1e-5, 77.59]);
  const out = samplePath(route, 120);
  assert.equal(out.length, 120);
  assert.deepEqual(out[0], route[0]);
  assert.deepEqual(out.at(-1), route.at(-1));
});

test('signal nodes at the same crossroads collapse to one junction', () => {
  const merged = mergeJunctions(
    [
      { osm_id: 1, lat: 12.975, lng: 77.59 },
      { osm_id: 2, lat: 12.9751, lng: 77.5901 }, // ~15 m away: same junction
      { osm_id: 3, lat: 12.98, lng: 77.59 }, // ~550 m away: a different one
    ],
    40,
  );
  assert.deepEqual(merged.map((s) => s.osm_id), [1, 3]);
});

test('signals are ordered by where the vehicle reaches them', () => {
  const route = densify([[12.97, 77.59], [12.988, 77.59]], 25);
  const ordered = orderAlongRoute(
    [
      { osm_id: 3, lat: 12.985, lng: 77.59 },
      { osm_id: 1, lat: 12.972, lng: 77.59 },
      { osm_id: 2, lat: 12.978, lng: 77.59 },
    ],
    route,
  );
  assert.deepEqual(ordered.map((s) => s.osm_id), [1, 2, 3]);
});

// --- Handler ---------------------------------------------------------------

test('rejects a body that is not JSON', async () => {
  const { deps } = upstream();
  assert.equal((await handler(post('nope'), deps)).status, 400);
});

test('rejects out-of-range coordinates without calling upstream', async () => {
  const { deps, calls } = upstream();
  const res = await handler(post({ ...VALID, destination: { latitude: 91, longitude: 0 } }), deps);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('asks OSRM for lon,lat order and GeoJSON geometry', async () => {
  const { deps, calls } = upstream();
  await handler(post(VALID), deps);
  assert.match(calls[0].url, /\/route\/v1\/driving\/77\.59,12\.97;77\.59,12\.988\?/);
  assert.match(calls[0].url, /geometries=geojson/);
});

test('returns a densified route in lat,lng order', async () => {
  const { deps } = upstream();
  const body = await (await handler(post(VALID), deps)).json();
  assert.deepEqual(body.route[0], [12.97, 77.59]);
  assert.ok(body.route.length >= 80, `only ${body.route.length} points`);
  assert.equal(body.distanceMeters, 1990);
  assert.equal(body.durationSeconds, 180);
});

test('returns signals merged into junctions and ordered along the route', async () => {
  const { deps } = upstream({
    overpass: {
      elements: [signalAt(30, 12.985), signalAt(10, 12.975), signalAt(11, 12.97505), signalAt(20, 12.98)],
    },
  });
  const body = await (await handler(post(VALID), deps)).json();
  assert.equal(body.signalsAvailable, true);
  assert.deepEqual(body.signals.map((s) => s.osm_id), [10, 20, 30]);
  assert.deepEqual(Object.keys(body.signals[0]).sort(), ['lat', 'lng', 'osm_id']);
});

test('queries Overpass for traffic signals around the route and identifies itself', async () => {
  const { deps, calls } = upstream();
  await handler(post(VALID), deps);
  const overpass = calls.find((c) => c.url.startsWith('https://overpass.test'));
  assert.ok(overpass, 'Overpass was not called');
  const query = decodeURIComponent(overpass.init.body.replace(/^data=/, ''));
  assert.match(query, /node\(around:25,12\.970000,77\.590000,.*\)\[highway=traffic_signals\]/);
  assert.equal(overpass.init.headers['User-Agent'], 'SUTRA-test');
  // overpass-api.de answers 406 to requests that do not ask for JSON.
  assert.equal(overpass.init.headers.Accept, 'application/json');
});

// The public Overpass servers are frequently overloaded (504) or rate limited.
test('falls back to the next Overpass mirror when one is busy', async () => {
  const { deps, calls } = upstream({ primaryStatus: 504, overpass: { elements: [signalAt(10, 12.975)] } });
  const body = await (await handler(post(VALID), deps)).json();
  assert.equal(body.signalsAvailable, true);
  assert.equal(body.signals.length, 1);
  assert.ok(calls.some((c) => c.url.startsWith('https://mirror.test')));
});

// The corridor matters more than the junction markers. Overpass is a free,
// shared service; when it is down the ambulance must still get its route.
test('still returns the route when the signal lookup fails', async () => {
  const { deps } = upstream({ overpassFails: true });
  const res = await handler(post(VALID), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.signalsAvailable, false);
  assert.deepEqual(body.signals, []);
  assert.ok(body.route.length > 2);
});

test('reports a routing failure as a 502', async () => {
  const { deps } = upstream({ osrm: { code: 'NoRoute', routes: [] } });
  const res = await handler(post(VALID), deps);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /NoRoute/);
});

test('a very long route stays within the database point limit', async () => {
  const { deps } = upstream({
    osrm: {
      code: 'Ok',
      routes: [{ geometry: { coordinates: [[77.0, 12.0], [77.0, 13.5]] }, distance: 166000, duration: 7200 }],
    },
  });
  const body = await (await handler(post(VALID), deps)).json();
  assert.ok(body.route.length <= 5000, `${body.route.length} points`);
});

test('a route with thousands of OSRM points still fits the database limit', async () => {
  const coordinates = Array.from({ length: 6000 }, (_, i) => [77.0 + (i % 2) * 1e-4, 12.0 + i * 2e-4]);
  const { deps } = upstream({ osrm: { code: 'Ok', routes: [{ geometry: { coordinates }, distance: 133000, duration: 6000 }] } });
  const body = await (await handler(post(VALID), deps)).json();
  assert.ok(body.route.length <= 5000, `${body.route.length} points`);
  assert.ok(body.route.length > 2000);
});
