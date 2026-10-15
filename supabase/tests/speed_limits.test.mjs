// The speed limit where a vehicle actually is.

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

/** A road running north through the origin. */
const road = (db, { name = 'MG Road', highway = 'primary', maxspeed = null, oneway = false, east = 0, id = 1 } = {}) => {
  const [aLat, aLng] = at(-500, east);
  const [bLat, bLng] = at(500, east);
  return db.query(
    `insert into public.road_segments (osm_way_id, name, highway, a_lat, a_lng, b_lat, b_lng, oneway, maxspeed_kmh)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, name, highway, aLat, aLng, bLat, bLng, oneway, maxspeed],
  );
};

const zone = (db, { name = 'St Mary School', limit = 25, size = 100 } = {}) =>
  db.query(
    `insert into public.zones (name, kind, polygon, speed_limit_kmh) values ($1, 'SCHOOL', $2, $3)`,
    [name, JSON.stringify([at(-size, -size), at(-size, size), at(size, size), at(size, -size)]), limit],
  );

const limitAt = async (db, [lat, lng], heading = 0) =>
  (await db.query(`select * from public.speed_limit_at($1, $2, $3)`, [lat, lng, heading])).rows[0];

const report = (db, [lat, lng], speed, heading = 0) =>
  db.query(
    `insert into public.vehicle_positions (vehicle_id, lat, lng, speed, heading)
     values ($1, $2, $3, $4, $5)
     on conflict (vehicle_id) do update
       set lat = excluded.lat, lng = excluded.lng, speed = excluded.speed,
           heading = excluded.heading, updated_at = now()`,
    [CAR, lat, lng, speed, heading],
  );

describe('which limit applies', () => {
  test('with nothing known, the global setting, as before', async () => {
    const db = await setup();
    assert.deepEqual(await limitAt(db, at(0)), { limit_kmh: 80, source: 'default', place: null });
  });

  test('the limit posted on the road the vehicle is on', async () => {
    const db = await setup();
    await road(db, { maxspeed: 50 });
    assert.deepEqual(await limitAt(db, at(0, 3)), { limit_kmh: 50, source: 'road', place: 'MG Road' });
  });

  test('either direction on a two-way road', async () => {
    const db = await setup();
    await road(db, { maxspeed: 50 });
    assert.equal((await limitAt(db, at(0), 180)).limit_kmh, 50);
  });

  // The case a naive "nearest road" gets wrong.
  test('not the limit of a road it is merely crossing or beside', async () => {
    const db = await setup();
    await road(db, { maxspeed: 100, highway: 'trunk', name: 'Highway' });
    // Heading east across it, as at a flyover or junction.
    assert.equal((await limitAt(db, at(0), 90)).source, 'default');
  });

  test('the nearest road it is travelling along wins over a parallel one', async () => {
    const db = await setup();
    await road(db, { maxspeed: 100, highway: 'trunk', name: 'Highway', id: 1 });
    await road(db, { maxspeed: 30, highway: 'service', name: 'Service lane', east: 12, id: 2 });
    assert.equal((await limitAt(db, at(0, 11))).place, 'Service lane');
    assert.equal((await limitAt(db, at(0, 1))).place, 'Highway');
  });

  test('a road with no posted limit uses the authority’s default for that kind of road', async () => {
    const db = await setup();
    await road(db, { highway: 'residential', name: 'Lane 4' });
    assert.equal((await limitAt(db, at(0))).source, 'default', 'nothing configured yet');
    await db.query(`insert into public.road_class_limits (highway, limit_kmh) values ('residential', 30)`);
    assert.deepEqual(await limitAt(db, at(0)), { limit_kmh: 30, source: 'road_class', place: 'Lane 4' });
  });

  test('a school zone overrides the road', async () => {
    const db = await setup();
    await road(db, { maxspeed: 50 });
    await zone(db, { limit: 25 });
    assert.deepEqual(await limitAt(db, at(0)), { limit_kmh: 25, source: 'zone', place: 'St Mary School' });
  });

  test('a zone without a limit changes nothing', async () => {
    const db = await setup();
    await road(db, { maxspeed: 50 });
    await zone(db, { limit: null });
    assert.equal((await limitAt(db, at(0))).limit_kmh, 50);
  });

  test('where two zones overlap, the stricter one', async () => {
    const db = await setup();
    await zone(db, { name: 'Hospital', limit: 30, size: 300 });
    await zone(db, { name: 'School', limit: 20, size: 100 });
    assert.equal((await limitAt(db, at(0))).place, 'School');
  });
});

describe('speeding against it', () => {
  test('65 is fine on the highway default and speeding on a 50 road, and the alert says where', async () => {
    const db = await setup();
    await road(db, { maxspeed: 50, name: 'MG Road' });
    await report(db, at(0), 65);
    const { rows } = await db.query(`select speed_limit, detail from public.violations`);
    assert.equal(rows[0].speed_limit, 50);
    assert.deepEqual(rows[0].detail, { limit_source: 'road', place: 'MG Road' });
    const a = (await db.query(`select message from public.alerts`)).rows[0];
    assert.equal(a.message, 'Overspeeding: 65 km/h on MG Road, where the limit is 50 km/h. Slow down.');
  });

  test('in a school zone the alert names the zone', async () => {
    const db = await setup();
    await zone(db, { limit: 25 });
    await report(db, at(0), 40);
    const a = (await db.query(`select message from public.alerts`)).rows[0];
    assert.equal(a.message, 'Overspeeding: 40 km/h in St Mary School, where the limit is 25 km/h. Slow down.');
  });

  test('with nothing more specific known, the old message is unchanged', async () => {
    const db = await setup();
    await report(db, at(0), 95);
    const a = (await db.query(`select message from public.alerts`)).rows[0];
    assert.equal(a.message, 'Overspeeding: 95 km/h in a 80 km/h zone. Slow down.');
  });

  test('an episode keeps the strictest limit it was broken against', async () => {
    const db = await setup();
    await zone(db, { limit: 25, size: 50 });
    await report(db, at(-200), 85); // on the open road, over 80
    await report(db, at(0), 60); // into the school zone, still over 25
    const { rows } = await db.query(`select speed_limit, speed from public.violations`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].speed_limit, 25);
    assert.equal(rows[0].speed, 85);
  });

  test('a broken lookup never blocks a position', async () => {
    const db = await setup();
    await db.query(`alter table public.zones disable trigger zones_prepare`);
    await db.query(
      `insert into public.zones (name, polygon, speed_limit_kmh, min_lat, max_lat, min_lng, max_lng)
       values ('Broken', '[["x",1],[0,0],[1,1]]', 25, -90, 90, -180, 180)`,
    );
    await report(db, at(0), 95);
    const { rows } = await db.query(`select count(*)::int as n from public.vehicle_positions`);
    assert.equal(rows[0].n, 1);
  });
});

test('only an operator sets road-class limits; anyone signed in can read them', async () => {
  const db = await setup();
  const insert = `insert into public.road_class_limits (highway, limit_kmh) values ('residential', 30)`;
  await asUser(db, OWNER, () => rejects(() => db.query(insert)));
  await asUser(db, OPS, async () => {
    await db.query(insert);
    await db.exec('commit; begin');
  });
  await asUser(db, OWNER, async () => {
    assert.equal((await db.query(`select count(*)::int as n from public.road_class_limits`)).rows[0].n, 1);
  });
});
