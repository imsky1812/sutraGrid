// Tests the Directions Edge Function's request handler.
//
// The handler is deliberately free of Deno globals so it can run here under
// Node's native type stripping. index.ts holds the Deno.serve/Deno.env wiring,
// which is six lines and has nothing to assert.
//
// It targets the Routes API rather than the legacy Directions API: Google Cloud
// projects created from early 2025 onward cannot enable the legacy endpoint.

import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../functions/directions/handler.ts';

const post = (body) =>
  new Request('http://localhost/directions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const VALID = {
  origin: { latitude: 12.97, longitude: 77.59 },
  destination: { latitude: 13.0, longitude: 77.6 },
};

const okUpstream = (encodedPolyline = '_p~iF~ps|U') => () =>
  Promise.resolve(
    new Response(JSON.stringify({ routes: [{ polyline: { encodedPolyline } }] }), { status: 200 }),
  );

const never = () => Promise.reject(new Error('upstream should not have been called'));

test('rejects a request with no origin', async () => {
  const res = await handler(post({ destination: VALID.destination }), {
    apiKey: 'test-key',
    fetchImpl: never,
  });
  assert.equal(res.status, 400);
});

test('rejects a request with no destination', async () => {
  const res = await handler(post({ origin: VALID.origin }), {
    apiKey: 'test-key',
    fetchImpl: never,
  });
  assert.equal(res.status, 400);
});

test('rejects non-numeric coordinates', async () => {
  const res = await handler(
    post({ origin: { latitude: 'north', longitude: 2 }, destination: VALID.destination }),
    { apiKey: 'test-key', fetchImpl: never },
  );
  assert.equal(res.status, 400);
});

test('rejects out-of-range coordinates', async () => {
  const res = await handler(
    post({ origin: { latitude: 999, longitude: 2 }, destination: VALID.destination }),
    { apiKey: 'test-key', fetchImpl: never },
  );
  assert.equal(res.status, 400);
});

test('rejects malformed JSON without throwing', async () => {
  const res = await handler(post('{not json'), { apiKey: 'test-key', fetchImpl: never });
  assert.equal(res.status, 400);
});

test('fails closed when no API key is configured', async () => {
  const res = await handler(post(VALID), { apiKey: '', fetchImpl: never });
  assert.equal(res.status, 500);
});

test('returns the encoded polyline on success', async () => {
  const res = await handler(post(VALID), { apiKey: 'test-key', fetchImpl: okUpstream() });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).polyline, '_p~iF~ps|U');
});

test('calls the Routes API, not the retired legacy endpoint', async () => {
  let calledUrl = null;
  const fetchImpl = (url) => {
    calledUrl = url;
    return okUpstream()();
  };

  await handler(post(VALID), { apiKey: 'test-key', fetchImpl });

  assert.equal(calledUrl, 'https://routes.googleapis.com/directions/v2:computeRoutes');
  assert.equal(String(calledUrl).includes('maps.googleapis.com'), false);
});

test('sends the key as a header and never in the URL', async () => {
  let seen = null;
  const fetchImpl = (url, init) => {
    seen = { url, init };
    return okUpstream()();
  };

  await handler(post(VALID), { apiKey: 'secret-key-value', fetchImpl });

  assert.equal(seen.init.headers['X-Goog-Api-Key'], 'secret-key-value');
  assert.equal(String(seen.url).includes('secret-key-value'), false);
});

// The Routes API rejects a request outright when no field mask is supplied.
test('requests only the encoded polyline via a field mask', async () => {
  let seen = null;
  const fetchImpl = (url, init) => {
    seen = init;
    return okUpstream()();
  };

  await handler(post(VALID), { apiKey: 'test-key', fetchImpl });

  assert.equal(seen.headers['X-Goog-FieldMask'], 'routes.polyline.encodedPolyline');
});

test('sends origin, destination and driving mode in the body', async () => {
  let seen = null;
  const fetchImpl = (url, init) => {
    seen = JSON.parse(init.body);
    return okUpstream()();
  };

  await handler(post(VALID), { apiKey: 'test-key', fetchImpl });

  assert.deepEqual(seen.origin.location.latLng, { latitude: 12.97, longitude: 77.59 });
  assert.deepEqual(seen.destination.location.latLng, { latitude: 13.0, longitude: 77.6 });
  assert.equal(seen.travelMode, 'DRIVE');
});

test('reports an upstream failure as 502', async () => {
  const fetchImpl = () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), { status: 403 }),
    );

  const res = await handler(post(VALID), { apiKey: 'test-key', fetchImpl });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /PERMISSION_DENIED/);
});

test('reports an empty route set as ZERO_RESULTS', async () => {
  const fetchImpl = () => Promise.resolve(new Response(JSON.stringify({ routes: [] }), { status: 200 }));
  const res = await handler(post(VALID), { apiKey: 'test-key', fetchImpl });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /ZERO_RESULTS/);
});

test('survives an upstream network error', async () => {
  const fetchImpl = () => Promise.reject(new Error('ECONNRESET'));
  const res = await handler(post(VALID), { apiKey: 'test-key', fetchImpl });
  assert.equal(res.status, 502);
});

test('survives an unreadable upstream response', async () => {
  const fetchImpl = () => Promise.resolve(new Response('<html>gateway error</html>', { status: 502 }));
  const res = await handler(post(VALID), { apiKey: 'test-key', fetchImpl });
  assert.equal(res.status, 502);
});

// The whole point of this function is that the key stays server-side. If it
// ever reaches a response body, the proxy is pointless.
test('never leaks the API key into a response', async () => {
  const SECRET = 'super-secret-key-value';
  const cases = [
    () => Promise.resolve(new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: `key ${SECRET} denied` } }), { status: 403 })),
    () => Promise.reject(new Error(`failed calling routes.googleapis.com with key=${SECRET}`)),
    () => Promise.resolve(new Response(`<html>${SECRET}</html>`, { status: 500 })),
    okUpstream(),
  ];

  for (const fetchImpl of cases) {
    const res = await handler(post(VALID), { apiKey: SECRET, fetchImpl });
    const body = await res.text();
    assert.equal(body.includes(SECRET), false, `key leaked in: ${body}`);
  }
});
