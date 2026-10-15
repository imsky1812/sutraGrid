// Harsh braking and wrong-way driving, and the speeding code that had to
// learn there is more than one kind of violation.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedUsers, asUser, rejects } from './harness.mjs';

const OWNER = '11111111-1111-1111-1111-111111111111';
const OPS = '33333333-3333-3333-3333-333333333333';
const CAR = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const LAT = 28.6139;
const LNG = 77.209;
const M_LAT = 110540;
const M_LNG = 111320 * Math.cos((LAT * Math.PI) / 180);
const at = (north, east = 0) => [LAT + north / M_LAT, LNG + east / M_LNG];

async function setup() {
  const db = await freshDb();
  await seedUsers(db, [
    { id: OWNER, email: 'o@x.com' },
    { id: OPS, email: 'ops@x.com' },
  ]);
  await db.query(
    `insert into public.vehicles (id, owner, vehicle_number, driver_name) values ($1, $2, 'DL 01 AA 0001', 'D')`,
    [CAR, OWNER],
  );
  await db.query(`insert into public.operators (user_id) values ($1)`, [OPS]);
  return db;
}

/** Report a position `secondsAgo` in the past, as the app would. */
const report = (db, [lat, lng], speed, heading = 0, secondsAgo = 0) =>
  db.query(
    `insert into public.vehicle_positions (vehicle_id, lat, lng, speed, heading, updated_at)
     values ($1, $2, $3, $4, $5, now() - make_interval(secs => $6))
     on conflict (vehicle_id) do update
       set lat = excluded.lat, lng = excluded.lng, speed = excluded.speed,
           heading = excluded.heading, updated_at = excluded.updated_at`,
    [CAR, lat, lng, speed, heading, secondsAgo],
  );

const violations = async (db, kind) =>
  (await db.query(`select * from public.violations where kind = $1 order by id`, [kind])).rows;

const alerts = async (db) =>
  (await db.query(`select severity, message from public.alerts order by id`)).rows;

describe('harsh braking', () => {
  test('a hard stop is recorded with how hard it was', async () => {
    const db = await setup();
    await report(db, at(0), 60, 0, 2); // 60 km/h two seconds ago
    await report(db, at(30), 25, 0, 0); // 25 km/h now: ~4.9 m/s²
    const [v] = await violations(db, 'HARSH_BRAKE');
    assert.ok(v, 'not recorded');
    assert.equal(Math.round(v.speed), 60);
    assert.equal(v.detail.from_kmh, 60);
    assert.equal(v.detail.to_kmh, 25);
    assert.ok(v.detail.decel_mps2 >= 4.5 && v.detail.decel_mps2 <= 5.1, JSON.stringify(v.detail));
    // An instant, not an open episode.
    assert.ok(v.cleared_at);
  });

  // The driver has just done an emergency stop. Beeping at them now only
  // distracts, and there is nothing left for them to do.
  test('the driver is not interrupted about it', async () => {
    const db = await setup();
    await report(db, at(0), 60, 0, 2);
    await report(db, at(30), 25, 0, 0);
    assert.deepEqual(await alerts(db), []);
  });

  test('ordinary braking for a junction is not harsh', async () => {
    const db = await setup();
    await report(db, at(0), 50, 0, 3);
    await report(db, at(30), 30, 0, 0); // ~1.9 m/s²
    assert.deepEqual(await violations(db, 'HARSH_BRAKE'), []);
  });

  // GPS speed at a crawl is mostly noise.
  test('a drop at walking pace means nothing', async () => {
    const db = await setup();
    await report(db, at(0), 15, 0, 1);
    await report(db, at(2), 0, 0, 0);
    assert.deepEqual(await violations(db, 'HARSH_BRAKE'), []);
  });

  // A big drop spread over a long gap is a slow stop seen through a gap in
  // reporting, not a hard one.
  test('a drop across a long gap in reporting is not harsh', async () => {
    const db = await setup();
    await report(db, at(0), 60, 0, 30);
    await report(db, at(100), 0, 0, 0);
    assert.deepEqual(await violations(db, 'HARSH_BRAKE'), []);
  });

  test('one stop is one event, however many frames it spans', async () => {
    const db = await setup();
    await report(db, at(0), 80, 0, 3);
    await report(db, at(30), 50, 0, 2);
    await report(db, at(45), 20, 0, 1);
    assert.equal((await violations(db, 'HARSH_BRAKE')).length, 1);
  });

  // The bug this migration fixed: the speeding code took "the open violation"
  // without asking what kind it was.
  test('speeding afterwards does not overwrite it', async () => {
    const db = await setup();
    await report(db, at(0), 60, 0, 2);
    await report(db, at(30), 25, 0, 1);
    await report(db, at(60), 95, 0, 0); // now speeding
    const [brake] = await violations(db, 'HARSH_BRAKE');
    assert.equal(Math.round(brake.speed), 60);
    assert.equal((await violations(db, 'SPEEDING')).length, 1);
  });
});

describe('speeding still behaves', () => {
  test('it is still announced, and only as speeding', async () => {
    const db = await setup();
    await report(db, at(0), 95);
    const a = await alerts(db);
    assert.equal(a.length, 1);
    assert.match(a[0].message, /^Overspeeding: 95 km\/h/);
  });
});

describe('wrong way', () => {
  /** A one-way road running north from the origin, 500 m long. */
  const oneWayNorth = (db, { oneway = true, name = 'MG Road' } = {}) => {
    const [aLat, aLng] = at(-250);
    const [bLat, bLng] = at(250);
    return db.query(
      `insert into public.road_segments (osm_way_id, name, highway, a_lat, a_lng, b_lat, b_lng, oneway)
       values (1001, $1, 'primary', $2, $3, $4, $5, $6)`,
      [name, aLat, aLng, bLat, bLng, oneway],
    );
  };

  /** Drive south down it: against the one-way direction. */
  const driveSouth = async (db, fixes, speed = 30) => {
    for (let i = 0; i < fixes; i++) await report(db, at(100 - i * 25), speed, 180, fixes - i);
  };

  test('several fixes against a one-way road is a violation, and the driver is told', async () => {
    const db = await setup();
    await oneWayNorth(db);
    await driveSouth(db, 3);
    const [v] = await violations(db, 'WRONG_WAY');
    assert.ok(v, 'not recorded');
    assert.equal(v.detail.road, 'MG Road');

    const [a] = await alerts(db);
    assert.equal(a.severity, 'CRITICAL');
    assert.match(a.message, /Wrong way: MG Road is one-way/);
  });

  // One fix could be a GPS jump onto the wrong road.
  test('a single fix is not enough', async () => {
    const db = await setup();
    await oneWayNorth(db);
    await driveSouth(db, 2);
    assert.deepEqual(await violations(db, 'WRONG_WAY'), []);
  });

  test('driving the right way along it is fine', async () => {
    const db = await setup();
    await oneWayNorth(db);
    for (let i = 0; i < 5; i++) await report(db, at(-100 + i * 25), 30, 0, 5 - i);
    assert.deepEqual(await violations(db, 'WRONG_WAY'), []);
  });

  test('either direction is fine on a two-way road', async () => {
    const db = await setup();
    await oneWayNorth(db, { oneway: false });
    await driveSouth(db, 5);
    assert.deepEqual(await violations(db, 'WRONG_WAY'), []);
  });

  // The failure mode of a naive check: on a divided road the opposite
  // carriageway is within GPS error, and is one-way the other way.
  test('a dual carriageway does not flag the carriageway beside you', async () => {
    const db = await setup();
    await oneWayNorth(db, { name: 'Northbound' });
    // The southbound carriageway, 8 m east, correctly one-way south.
    const [aLat, aLng] = at(250, 8);
    const [bLat, bLng] = at(-250, 8);
    await db.query(
      `insert into public.road_segments (osm_way_id, name, highway, a_lat, a_lng, b_lat, b_lng, oneway)
       values (1002, 'Southbound', 'primary', $1, $2, $3, $4, true)`,
      [aLat, aLng, bLat, bLng],
    );
    // Driving south, GPS putting the car between the two.
    for (let i = 0; i < 5; i++) await report(db, at(100 - i * 25, 4), 40, 180, 5 - i);
    assert.deepEqual(await violations(db, 'WRONG_WAY'), []);
  });

  test('reversing slowly out of a gate is not driving the wrong way', async () => {
    const db = await setup();
    await oneWayNorth(db);
    await driveSouth(db, 5, 6);
    assert.deepEqual(await violations(db, 'WRONG_WAY'), []);
  });

  test('far from any known road, nothing is assumed', async () => {
    const db = await setup();
    await driveSouth(db, 5);
    assert.deepEqual(await violations(db, 'WRONG_WAY'), []);
  });

  test('once per road, not every few seconds while they find a place to turn', async () => {
    const db = await setup();
    await oneWayNorth(db);
    await driveSouth(db, 9);
    assert.equal((await violations(db, 'WRONG_WAY')).length, 1);
  });
});

describe('road data', () => {
  test('anyone signed in can read it; only an operator can load it', async () => {
    const db = await setup();
    const row = [2001, 'X', 'primary', LAT, LNG, LAT + 0.001, LNG, true];
    const insert = `insert into public.road_segments (osm_way_id, name, highway, a_lat, a_lng, b_lat, b_lng, oneway)
                    values ($1, $2, $3, $4, $5, $6, $7, $8)`;

    await asUser(db, OWNER, () => rejects(() => db.query(insert, row)));
    await asUser(db, OPS, async () => {
      await db.query(insert, row);
      await db.exec('commit; begin');
    });
    await asUser(db, OWNER, async () => {
      const { rows } = await db.query(`select name, round(bearing::numeric) as bearing from public.road_segments`);
      assert.deepEqual(rows, [{ name: 'X', bearing: '0' }]);
    });
  });

  test('segment distance and heading gap', async () => {
    const db = await setup();
    const [aLat, aLng] = at(0);
    const [bLat, bLng] = at(100);
    const [pLat, pLng] = at(50, 10);
    const { rows } = await db.query(
      `select round(public.segment_distance_m($1, $2, $3, $4, $5, $6)::numeric) as beside,
              round(public.segment_distance_m($7, $8, $3, $4, $5, $6)::numeric) as beyond,
              public.heading_gap(350, 10) as wraps,
              public.heading_gap(0, 180) as opposite`,
      [pLat, pLng, aLat, aLng, bLat, bLng, ...at(130)],
    );
    assert.deepEqual(rows[0], { beside: '10', beyond: '30', wraps: 20, opposite: 180 });
  });
});

test('none of the checks is callable by a client', async () => {
  const db = await setup();
  const { rows } = await db.query(`
    select has_function_privilege('authenticated', 'public.detect_harsh_brake()', 'execute') as brake,
           has_function_privilege('authenticated', 'public.detect_wrong_way()', 'execute') as wrong_way`);
  assert.deepEqual(rows[0], { brake: false, wrong_way: false });
});
