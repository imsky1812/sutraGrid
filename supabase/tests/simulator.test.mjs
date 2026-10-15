// The arithmetic behind the fleet simulator.
//
// Nothing here touches the database, so it runs beside the Edge Function
// handler tests. It matters because every demo run is built on top of it: a
// simulator whose vehicles teleport, or sit at a constant speed, would make
// the whole system look either broken or fake.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  bearing,
  createDriver,
  distanceM,
  measure,
  nextSpeed,
  pickDestination,
  plateFor,
  positionAlong,
  project,
} from '../../tools/simulator.mjs';

const DELHI = [28.6139, 77.209];
/** A straight kilometre due north, as OSRM would return its bends. */
const ROUTE = [0, 250, 500, 750, 1000].map((m) => project(DELHI, 0, m));

test('it measures distances the way the database does', () => {
  assert.equal(Math.round(distanceM([0, 0], [1, 0])), 110540);
});

test('cumulative distance follows the route', () => {
  const along = measure(ROUTE);
  assert.equal(along[0], 0);
  assert.equal(Math.round(along[4]), 1000);
  assert.ok(along.every((v, i) => i === 0 || v > along[i - 1]));
});

describe('position along a route', () => {
  const along = measure(ROUTE);

  test('lands where it should and faces the way it is going', () => {
    const { point, heading, done } = positionAlong(ROUTE, along, 400);
    assert.equal(Math.round(distanceM(DELHI, point)), 400);
    assert.ok(Math.abs(heading) < 1 || Math.abs(heading - 360) < 1, `heading ${heading}`);
    assert.equal(done, false);
  });

  test('interpolates inside a segment rather than hopping between points', () => {
    const a = positionAlong(ROUTE, along, 300).point;
    const b = positionAlong(ROUTE, along, 310).point;
    assert.ok(distanceM(a, b) > 0 && distanceM(a, b) < 15);
    // And neither is a route vertex.
    assert.ok(ROUTE.every((p) => distanceM(p, a) > 1));
  });

  // The cue to pick a new destination, not to stop reporting a position.
  test('reports arrival at the end', () => {
    const end = positionAlong(ROUTE, along, 5000);
    assert.equal(end.done, true);
    assert.equal(Math.round(distanceM(DELHI, end.point)), 1000);
  });

  test('a route with one point does not crash', () => {
    const single = [DELHI];
    assert.equal(positionAlong(single, measure(single), 10).done, true);
  });
});

describe('speed', () => {
  // Constant speed is what makes a simulation look like a simulation.
  test('wanders around the target without exceeding it much', () => {
    let speed = 40;
    let seen = new Set();
    for (let i = 0; i < 200; i++) {
      speed = nextSpeed(speed, 40);
      assert.ok(speed >= 0 && speed <= 46, `speed ${speed}`);
      seen.add(Math.round(speed));
    }
    assert.ok(seen.size > 5, 'speed never varied');
  });

  test('crawls occasionally, as though for a junction', () => {
    assert.ok(nextSpeed(40, 40, () => 0.01) < 5);
  });

  test('a stopped vehicle gets going again', () => {
    assert.ok(nextSpeed(0, 40, () => 0.5) > 0);
  });
});

test('destinations land in a ring around the centre, not on it', () => {
  for (let i = 0; i < 50; i++) {
    const d = distanceM(DELHI, pickDestination(DELHI, 1000));
    assert.ok(d >= 490 && d <= 1010, `${d} m away`);
  }
});

test('simulated plates are obviously simulated', () => {
  assert.equal(plateFor(0), 'SIM 0001');
  assert.equal(plateFor(11), 'SIM 0012');
  // The console renders these; they must pass the app's own character rule.
  assert.ok(/^[A-Za-z0-9 _-]{1,32}$/.test(plateFor(0)));
});

describe('a driver', () => {
  const driver = () => createDriver({ id: 'veh-1', plate: 'SIM 0001', targetKmh: 36, random: () => 0.5 });

  test('asks for a route before it will move', () => {
    const d = driver();
    assert.equal(d.needsRoute, true);
    assert.equal(d.advance(2), null);
  });

  test('moves along the route it was given', () => {
    const d = driver();
    d.setRoute(ROUTE);
    const first = d.advance(2);
    const second = d.advance(2);
    assert.ok(distanceM([first.lat, first.lng], [second.lat, second.lng]) > 5);
    assert.ok(second.speed > 0);
    assert.equal(d.needsRoute, false);
  });

  test('asks for another route once it arrives', () => {
    const d = driver();
    d.setRoute(ROUTE);
    for (let i = 0; i < 200 && !d.needsRoute; i++) d.advance(2);
    assert.equal(d.needsRoute, true);
  });

  test('every frame is something the database would accept', () => {
    const d = driver();
    d.setRoute(ROUTE);
    for (let i = 0; i < 40; i++) {
      const f = d.advance(2);
      if (!f) continue;
      assert.ok(f.lat >= -90 && f.lat <= 90);
      assert.ok(f.lng >= -180 && f.lng <= 180);
      assert.ok(f.speed >= 0 && f.speed <= 500, `speed ${f.speed}`);
      assert.ok(f.heading >= 0 && f.heading <= 360, `heading ${f.heading}`);
    }
  });
});

test('bearing reads as a compass', () => {
  assert.ok(Math.abs(bearing(DELHI, project(DELHI, 90, 100)) - 90) < 0.5);
  assert.ok(Math.abs(bearing(DELHI, project(DELHI, 180, 100)) - 180) < 0.5);
});
