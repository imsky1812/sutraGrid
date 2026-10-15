// The console's replay arithmetic: where a vehicle was at any moment of a trip.
//
// Runs every animation frame over trips of thousands of points, so it binary
// searches; the tests pin that the search lands on the right pair and that
// interpolation between them is honest.

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, positionAt } from '../../admin-dashboard/replay-math.js';

const T0 = Date.parse('2026-10-15T09:00:00Z');
/** A point every 3 s, moving north 0.0003° (~33 m) each time, speeding up. */
const TRIP = Array.from({ length: 1000 }, (_, i) => ({
  t: T0 + i * 3000,
  lat: 28.6 + i * 0.0003,
  lng: 77.2,
  speed: 20 + (i % 50),
  heading: 0,
}));

test('at a recorded fix it is exactly that fix', () => {
  const p = positionAt(TRIP, TRIP[500].t);
  assert.equal(p.lat, TRIP[500].lat);
});

test('between two fixes it is between them, in proportion', () => {
  const p = positionAt(TRIP, TRIP[500].t + 1000); // a third of the way
  const expected = TRIP[500].lat + (TRIP[501].lat - TRIP[500].lat) / 3;
  assert.ok(Math.abs(p.lat - expected) < 1e-9);
  assert.ok(p.speed > TRIP[500].speed && p.speed < TRIP[501].speed);
});

test('before the start and after the end it holds still', () => {
  assert.equal(positionAt(TRIP, T0 - 60_000), TRIP[0]);
  assert.equal(positionAt(TRIP, T0 + 10_000_000), TRIP[TRIP.length - 1]);
});

// Every point, not a sample: the search must never land on the wrong pair.
test('the search finds the right pair everywhere in the trip', () => {
  for (let i = 0; i < TRIP.length - 1; i++) {
    const mid = positionAt(TRIP, TRIP[i].t + 1500);
    assert.ok(mid.lat > TRIP[i].lat && mid.lat < TRIP[i + 1].lat, `wrong pair at ${i}`);
  }
});

test('two fixes with the same timestamp do not divide by zero', () => {
  const twins = [
    { t: T0, lat: 1, lng: 1, speed: 10, heading: 0 },
    { t: T0, lat: 2, lng: 2, speed: 20, heading: 0 },
    { t: T0 + 1000, lat: 3, lng: 3, speed: 30, heading: 0 },
  ];
  const p = positionAt(twins, T0 + 500);
  assert.ok(Number.isFinite(p.lat));
});

test('durations read the way people say them', () => {
  assert.equal(formatDuration(20_000), '1 min');
  assert.equal(formatDuration(26 * 60_000), '26 min');
  assert.equal(formatDuration(95 * 60_000), '1 h 35 min');
});
