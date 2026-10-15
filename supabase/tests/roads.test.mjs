// Turning OpenStreetMap roads into segments.
//
// The rule that matters most is direction. A segment must run a -> b the way
// traffic is allowed; get a oneway=-1 road backwards and every lawful driver
// on it is told they are going the wrong way.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  batches,
  bboxAround,
  maxspeedOf,
  onewayOf,
  overpassQuery,
  segmentsFromWays,
} from '../../tools/roads.mjs';

const way = (id, tags, coords) => ({
  type: 'way',
  id,
  tags,
  geometry: coords.map(([lat, lon]) => ({ lat, lon })),
});

describe('which way traffic may go', () => {
  test('plain tags', () => {
    assert.equal(onewayOf({ oneway: 'yes' }), 'forward');
    assert.equal(onewayOf({ oneway: '1' }), 'forward');
    assert.equal(onewayOf({ oneway: 'no' }), 'none');
    assert.equal(onewayOf({}), 'none');
  });

  test('one-way against the drawing order', () => {
    assert.equal(onewayOf({ oneway: '-1' }), 'reverse');
  });

  test('motorways and roundabouts are one-way unless said otherwise', () => {
    assert.equal(onewayOf({ highway: 'motorway' }), 'forward');
    assert.equal(onewayOf({ junction: 'roundabout' }), 'forward');
    assert.equal(onewayOf({ highway: 'motorway', oneway: 'no' }), 'none');
  });

  // One-way only at some hours: flagging it all day would accuse people
  // driving it lawfully.
  test('time-dependent one-ways are not treated as one-way', () => {
    assert.equal(onewayOf({ oneway: 'reversible' }), 'none');
    assert.equal(onewayOf({ oneway: 'alternating' }), 'none');
  });
});

describe('segments', () => {
  test('one per pair of consecutive nodes, carrying the road’s tags', () => {
    const rows = segmentsFromWays([
      way(1, { highway: 'primary', name: 'MG Road', oneway: 'yes', maxspeed: '50' }, [
        [28.60, 77.20],
        [28.61, 77.20],
        [28.62, 77.20],
      ]),
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      osm_way_id: 1,
      name: 'MG Road',
      highway: 'primary',
      a_lat: 28.6,
      a_lng: 77.2,
      b_lat: 28.61,
      b_lng: 77.2,
      oneway: true,
      maxspeed_kmh: 50,
    });
  });

  test('a oneway=-1 road is flipped so a -> b is the legal direction', () => {
    const [first] = segmentsFromWays([
      way(2, { highway: 'residential', oneway: '-1' }, [
        [28.60, 77.20],
        [28.61, 77.20],
      ]),
    ]);
    // Drawn northwards, legal southwards.
    assert.equal(first.a_lat, 28.61);
    assert.equal(first.b_lat, 28.6);
    assert.equal(first.oneway, true);
  });

  test('an unnamed road falls back to its reference number', () => {
    const [row] = segmentsFromWays([
      way(3, { highway: 'trunk', ref: 'NH 9' }, [
        [28.6, 77.2],
        [28.61, 77.2],
      ]),
    ]);
    assert.equal(row.name, 'NH 9');
  });

  test('broken or degenerate geometry is skipped, not guessed at', () => {
    const rows = segmentsFromWays([
      { type: 'node', id: 9 },
      way(4, { highway: 'primary' }, [[28.6, 77.2]]),
      way(5, { highway: 'primary' }, [
        [28.6, 77.2],
        [28.6, 77.2],
      ]),
      { type: 'way', id: 6, tags: {}, geometry: [{ lat: 1 }, { lat: 2, lon: 3 }] },
    ]);
    assert.deepEqual(rows, []);
  });
});

describe('speed limits', () => {
  test('numbers in km/h or mph', () => {
    assert.equal(maxspeedOf('50'), 50);
    assert.equal(maxspeedOf('60 km/h'), 60);
    assert.equal(maxspeedOf('30 mph'), 48);
  });

  test('anything else is unknown, not zero', () => {
    for (const raw of [undefined, null, 'IN:urban', 'walk', 'none', '0', '900']) {
      assert.equal(maxspeedOf(raw), null, String(raw));
    }
  });
});

test('the box is centred and sized in metres', () => {
  const [s, w, n, e] = bboxAround(28.6, 77.2, 1000);
  assert.ok(Math.abs((n - s) * 110540 - 2000) < 1);
  assert.ok(e - w > n - s, 'longitude degrees are shorter here, so the box is wider in degrees');
});

test('the query asks for drivable roads with their geometry', () => {
  const q = overpassQuery([1, 2, 3, 4]);
  assert.match(q, /way\["highway"~"\^\(motorway\|/);
  assert.match(q, /\(1,2,3,4\)/);
  assert.match(q, /out geom tags;$/);
  assert.doesNotMatch(q, /footway|cycleway/);
});

test('batches cover every row exactly once', () => {
  const rows = Array.from({ length: 1234 }, (_, i) => i);
  const b = batches(rows, 500);
  assert.deepEqual(b.map((x) => x.length), [500, 500, 234]);
  assert.equal(b.flat().length, 1234);
});
