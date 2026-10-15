// Zones, and the single events record every check now writes into.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedUsers, asUser, rejects } from './harness.mjs';

const OWNER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const OPS = '33333333-3333-3333-3333-333333333333';
const CAR = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VAN = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const LAT = 28.6139;
const LNG = 77.209;
const M_LAT = 110540;
const M_LNG = 111320 * Math.cos((LAT * Math.PI) / 180);
const at = (north, east = 0) => [LAT + north / M_LAT, LNG + east / M_LNG];

/** A 200 m square centred on the origin. */
const SQUARE = [at(-100, -100), at(-100, 100), at(100, 100), at(100, -100)];

async function setup() {
  const db = await freshDb();
  await seedUsers(db, [
    { id: OWNER, email: 'o@x.com' },
    { id: OTHER, email: 'x@x.com' },
    { id: OPS, email: 'ops@x.com' },
  ]);
  await db.query(
    `insert into public.vehicles (id, owner, vehicle_number, driver_name) values
       ($1, $3, 'DL 01 AA 0001', 'D'), ($2, $4, 'DL 02 BB 0002', 'E')`,
    [CAR, VAN, OWNER, OTHER],
  );
  await db.query(`insert into public.operators (user_id) values ($1)`, [OPS]);
  return db;
}

const addZone = async (db, { name = 'St Mary School', kind = 'SCHOOL', polygon = SQUARE, message = 'School zone: slow down, children crossing', active = true } = {}) =>
  (
    await db.query(
      `insert into public.zones (name, kind, polygon, alert_message, active) values ($1, $2, $3, $4, $5) returning id`,
      [name, kind, JSON.stringify(polygon), message, active],
    )
  ).rows[0].id;

const report = (db, [lat, lng], speed = 20, heading = 0, vehicle = CAR) =>
  db.query(
    `insert into public.vehicle_positions (vehicle_id, lat, lng, speed, heading)
     values ($1, $2, $3, $4, $5)
     on conflict (vehicle_id) do update
       set lat = excluded.lat, lng = excluded.lng, speed = excluded.speed,
           heading = excluded.heading, updated_at = now()`,
    [vehicle, lat, lng, speed, heading],
  );

const events = async (db, kind) =>
  (
    await db.query(
      kind
        ? `select * from public.events where kind = $1 order by id`
        : `select * from public.events order by id`,
      kind ? [kind] : [],
    )
  ).rows;

const alerts = async (db) => (await db.query(`select message, severity from public.alerts order by id`)).rows;

describe('point in polygon', () => {
  test('inside, outside, and a concave shape', async () => {
    const db = await setup();
    // An L: the notch at the top right is outside.
    const L = [at(0, 0), at(0, 200), at(100, 200), at(100, 100), at(200, 100), at(200, 0)];
    const q = (p) =>
      db.query(`select public.point_in_polygon($1, $2, $3) as inside`, [p[0], p[1], JSON.stringify(L)]).then((r) => r.rows[0].inside);
    assert.equal(await q(at(50, 50)), true);
    assert.equal(await q(at(150, 50)), true);
    assert.equal(await q(at(150, 150)), false, 'the notch');
    assert.equal(await q(at(-10, 50)), false);
  });
});

describe('zones', () => {
  test('entering one is an event, and the driver hears the zone’s message', async () => {
    const db = await setup();
    const zone = await addZone(db);
    await report(db, at(-200));
    await report(db, at(0));

    const [e] = await events(db, 'ZONE_ENTER');
    assert.equal(Number(e.zone_id), Number(zone));
    assert.equal(e.detail.zone, 'St Mary School');

    const a = await alerts(db);
    assert.deepEqual(a, [{ message: 'School zone: slow down, children crossing', severity: 'WARNING' }]);
  });

  test('staying inside is not a new arrival', async () => {
    const db = await setup();
    await addZone(db);
    for (const n of [0, 20, 40, 60]) await report(db, at(n));
    assert.equal((await events(db, 'ZONE_ENTER')).length, 1);
    assert.equal((await alerts(db)).length, 1);
  });

  test('leaving takes two fixes outside, and records how long it was inside', async () => {
    const db = await setup();
    await addZone(db);
    await report(db, at(0));
    await report(db, at(150));
    assert.equal((await events(db, 'ZONE_EXIT')).length, 0, 'one fix outside is not leaving');
    await report(db, at(170));
    const [exit] = await events(db, 'ZONE_EXIT');
    assert.ok(exit, 'not recorded');
    assert.ok('minutes_inside' in exit.detail);
  });

  // GPS wandering over the boundary of a zone a car is parked on.
  test('jitter across the edge does not flap in and out', async () => {
    const db = await setup();
    await addZone(db);
    for (const n of [95, 105, 95, 105, 95, 105]) await report(db, at(n));
    assert.equal((await events(db, 'ZONE_ENTER')).length, 1);
    assert.equal((await events(db, 'ZONE_EXIT')).length, 0);
  });

  test('back in within two minutes is the same visit: no second alert', async () => {
    const db = await setup();
    await addZone(db);
    await report(db, at(0));
    await report(db, at(150));
    await report(db, at(170));
    await report(db, at(0));
    assert.equal((await events(db, 'ZONE_ENTER')).length, 1);
    assert.equal((await alerts(db)).length, 1);
  });

  test('a zone without a message is recorded but says nothing', async () => {
    const db = await setup();
    await addZone(db, { kind: 'DEPOT', name: 'Depot', message: null });
    await report(db, at(0));
    assert.equal((await events(db, 'ZONE_ENTER')).length, 1);
    assert.deepEqual(await alerts(db), []);
  });

  test('a switched-off zone is ignored', async () => {
    const db = await setup();
    await addZone(db, { active: false });
    await report(db, at(0));
    assert.deepEqual(await events(db, 'ZONE_ENTER'), []);
  });

  test('a malformed zone is refused', async () => {
    const db = await setup();
    for (const polygon of [[at(0), at(1)], 'nope', [[91, 0], [0, 0], [0, 1]], [[1, 2, 3], [0, 0], [0, 1]]]) {
      await rejects(() => addZone(db, { polygon }), { code: '22023' });
    }
  });

  test('only an operator draws zones; everyone can see them', async () => {
    const db = await setup();
    const insert = `insert into public.zones (name, polygon) values ('Mine', $1)`;
    await asUser(db, OWNER, () => rejects(() => db.query(insert, [JSON.stringify(SQUARE)])));
    await asUser(db, OPS, async () => {
      await db.query(insert, [JSON.stringify(SQUARE)]);
      await db.exec('commit; begin');
    });
    await asUser(db, OWNER, async () => {
      const { rows } = await db.query(`select name, min_lat is not null as boxed from public.zones`);
      assert.deepEqual(rows, [{ name: 'Mine', boxed: true }]);
    });
  });
});

describe('one record of everything', () => {
  test('speeding becomes an OVERSPEED event', async () => {
    const db = await setup();
    await report(db, at(-500), 95);
    const [e] = await events(db, 'OVERSPEED');
    assert.equal(e.detail.speed, 95);
    assert.equal(e.detail.limit, 80);
  });

  test('a collision warning is one event for each vehicle', async () => {
    const db = await setup();
    await report(db, at(-40, -400), 36, 0, CAR);
    await report(db, at(0, -440), 36, 90, VAN);
    const rows = await events(db, 'CONFLICT');
    assert.deepEqual(rows.map((r) => r.vehicle_id).sort(), [CAR, VAN]);
  });

  test('a corridor starting and ending are both events', async () => {
    const db = await setup();
    const { rows } = await db.query(
      `insert into public.corridors (vehicle_id, destination_lat, destination_lng, destination_name)
       values ($1, $2, $3, 'City Hospital') returning id`,
      [CAR, LAT, LNG],
    );
    await db.query(`update public.corridors set status = 'ENDED', ended_at = now() where id = $1`, [rows[0].id]);
    assert.equal((await events(db, 'CORRIDOR_START'))[0].detail.destination, 'City Hospital');
    assert.equal((await events(db, 'CORRIDOR_END')).length, 1);
  });

  test('a driver sees their own events; an operator sees everyone’s', async () => {
    const db = await setup();
    await report(db, at(-500), 95, 0, CAR);
    await report(db, at(-600), 95, 0, VAN);

    await asUser(db, OWNER, async () => {
      const { rows } = await db.query(`select vehicle_id from public.events`);
      assert.deepEqual(rows.map((r) => r.vehicle_id), [CAR]);
    });
    await asUser(db, OPS, async () => {
      const { rows } = await db.query(`select count(*)::int as n from public.events`);
      assert.equal(rows[0].n, 2);
    });
  });

  test('nobody writes events directly', async () => {
    const db = await setup();
    await asUser(db, OWNER, () =>
      rejects(() => db.query(`insert into public.events (vehicle_id, kind) values ($1, 'OVERSPEED')`, [CAR])),
    );
  });

  test('old events are pruned with everything else', async () => {
    const db = await setup();
    await db.query(
      `insert into public.events (vehicle_id, kind, occurred_at) values ($1, 'OVERSPEED', now() - interval '40 days')`,
      [CAR],
    );
    const { rows } = await db.query(`select * from public.prune_old_data() where pruned_table = 'events'`);
    assert.equal(Number(rows[0].removed), 1);
  });
});

// Every check here runs inside a position update.
test('a broken zone check never blocks a position', async () => {
  const db = await setup();
  await addZone(db);
  // Corrupt the stored polygon underneath the validation trigger.
  await db.query(`alter table public.zones disable trigger zones_prepare`);
  await db.query(`update public.zones set polygon = '[["x", 1], [0, 0], [1, 1]]'`);
  await report(db, at(0));
  const { rows } = await db.query(`select count(*)::int as n from public.vehicle_positions`);
  assert.equal(rows[0].n, 1);
});
