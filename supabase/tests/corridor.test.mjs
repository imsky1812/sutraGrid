import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedUsers, asUser, rejects } from './harness.mjs';

const MEDIC = '11111111-1111-1111-1111-111111111111';
const DRIVER = '22222222-2222-2222-2222-222222222222';
const OPERATOR = '33333333-3333-3333-3333-333333333333';

const AMB = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CAR = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CAR2 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
// Registered as an ambulance but never authorized by an operator.
const UNAUTH = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

// A straight road running north, one point every ~24.9 m, ~1.99 km long.
const LAT0 = 12.97;
const LNG = 77.59;
const STEP = 0.000225;
const at = (i) => [LAT0 + i * STEP, LNG];
const ROUTE = Array.from({ length: 81 }, (_, i) => at(i));
// Metres per degree of longitude at this latitude.
const EAST_M = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const east = (i, metres) => [LAT0 + i * STEP, LNG + metres / EAST_M];

// Junctions at ~597 m, ~1194 m and ~1791 m along the route.
const SIGNALS = [24, 48, 72].map((i, n) => ({ osm_id: 1000 + n, lat: at(i)[0], lng: at(i)[1] }));

async function setup() {
  const db = await freshDb();
  await seedUsers(db, [
    { id: MEDIC, email: 'medic@x.com' },
    { id: DRIVER, email: 'driver@x.com' },
    { id: OPERATOR, email: 'ops@x.com' },
  ]);
  await db.query(
    `insert into public.vehicles (id, owner, vehicle_number, driver_name, vehicle_type, is_emergency_authorized) values
       ($1, $2, 'KA-01-AMB-0001', 'Medic', 'AMBULANCE', true),
       ($3, $4, 'KA-03-AB-1234', 'Driver', 'NORMAL', false),
       ($5, $4, 'KA-03-CD-5678', 'Driver', 'NORMAL', false),
       ($6, $2, 'KA-01-AMB-0002', 'Medic', 'AMBULANCE', false)`,
    [AMB, MEDIC, CAR, DRIVER, CAR2, UNAUTH],
  );
  await db.query(`insert into public.operators (user_id) values ($1)`, [OPERATOR]);
  return db;
}

/** Make auth.uid() return this user while staying superuser (RLS bypassed). */
const claim = (db, userId) =>
  db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ]);

const start = async (db, vehicleId = AMB, route = ROUTE, signals = SIGNALS) => {
  const { rows } = await db.query(
    `select public.start_corridor($1, 'City General Hospital', $2::jsonb, $3::jsonb, 1990, 180) as id`,
    [vehicleId, JSON.stringify(route), JSON.stringify(signals)],
  );
  return rows[0].id;
};

const place = (db, vehicleId, [lat, lng], age = '0 seconds') =>
  db.query(
    `insert into public.vehicle_positions (vehicle_id, lat, lng, speed, heading, updated_at)
     values ($1, $2, $3, 40, 0, now() - $4::interval)
     on conflict (vehicle_id) do update
       set lat = excluded.lat, lng = excluded.lng, updated_at = excluded.updated_at`,
    [vehicleId, lat, lng, age],
  );

const states = async (db, id) =>
  (
    await db.query(`select state from public.corridor_signals where corridor_id = $1 order by seq`, [id])
  ).rows.map((r) => r.state);

const warnedAlerts = async (db, vehicleId) =>
  (
    await db.query(
      `select category, severity, message from public.alerts where vehicle_id = $1 and category = 'EMERGENCY'`,
      [vehicleId],
    )
  ).rows;

const status = async (db, id) =>
  (await db.query(`select status from public.corridors where id = $1`, [id])).rows[0].status;

// --- Starting a corridor --------------------------------------------------

test('an authorized emergency vehicle can start a corridor', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  const id = await start(db);
  assert.equal(await status(db, id), 'ACTIVE');
});

test('a vehicle without emergency authorization cannot start one', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  await rejects(() => start(db, UNAUTH), { code: '42501' });
});

test("a driver cannot start a corridor on someone else's ambulance", async () => {
  const db = await setup();
  await claim(db, DRIVER);
  await rejects(() => start(db, AMB), { code: '42501' });
});

test('a route needs at least two points', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  await rejects(() => start(db, AMB, [at(0)]), { message: 'route' });
});

test('the route is stored with cumulative distance', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  const id = await start(db);
  const { rows } = await db.query(
    `select along_m from public.corridor_route_points where corridor_id = $1 order by seq`,
    [id],
  );
  assert.equal(rows.length, 81);
  assert.equal(Number(rows[0].along_m), 0);
  assert.ok(Math.abs(Number(rows[80].along_m) - 1990) < 15, `got ${rows[80].along_m}`);
});

test('signals are placed and ordered along the route', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  // Supplied out of order: the database must sort them by distance along.
  const id = await start(db, AMB, ROUTE, [SIGNALS[2], SIGNALS[0], SIGNALS[1]]);
  const { rows } = await db.query(
    `select osm_id, along_m from public.corridor_signals where corridor_id = $1 order by seq`,
    [id],
  );
  assert.deepEqual(rows.map((r) => Number(r.osm_id)), [1000, 1001, 1002]);
  assert.ok(Math.abs(Number(rows[0].along_m) - 597) < 15);
});

test('starting a new corridor ends the previous one', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  const first = await start(db);
  const second = await start(db);
  assert.equal(await status(db, first), 'ENDED');
  assert.equal(await status(db, second), 'ACTIVE');
});

// --- Simulated signal pre-emption ------------------------------------------

test('signals start out waiting', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  const id = await start(db);
  await place(db, AMB, at(0));
  assert.deepEqual(await states(db, id), ['WAITING', 'WAITING', 'WAITING']);
});

test('a signal pre-empts within 500 m and turns green within 200 m', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  const id = await start(db);

  await place(db, AMB, at(6)); // ~448 m from the first junction
  assert.deepEqual(await states(db, id), ['PREEMPT', 'WAITING', 'WAITING']);

  await place(db, AMB, at(20)); // ~100 m from it
  assert.deepEqual(await states(db, id), ['GREEN', 'WAITING', 'WAITING']);
});

test('a junction the vehicle has cleared is marked passed', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  const id = await start(db);
  await place(db, AMB, at(30)); // ~149 m past the first, ~448 m before the second
  assert.deepEqual(await states(db, id), ['PASSED', 'PREEMPT', 'WAITING']);
});

// GPS jitter can snap the vehicle a point backwards; a passed junction must
// not flip back to green behind it.
test('passed is sticky', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  const id = await start(db);
  await place(db, AMB, at(30));
  await place(db, AMB, at(23));
  assert.equal((await states(db, id))[0], 'PASSED');
});

test('only the corridor vehicle moves the signals', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  const id = await start(db);
  await place(db, CAR, at(24));
  assert.deepEqual(await states(db, id), ['WAITING', 'WAITING', 'WAITING']);
});

// --- Warning the drivers ahead ---------------------------------------------

test('a driver on the route ahead is warned', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  await start(db);
  await place(db, CAR, east(40, 50)); // ~995 m ahead, 50 m off the centre line
  await place(db, AMB, at(0));

  const alerts = await warnedAlerts(db, CAR);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'CRITICAL');
  assert.match(alerts[0].message, /KA-01-AMB-0001/);
  assert.match(alerts[0].message, /give way/i);
});

test('a driver is warned once per corridor, not on every update', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  await start(db);
  await place(db, CAR, east(40, 50));
  for (const i of [0, 2, 4, 6]) await place(db, AMB, at(i));
  assert.equal((await warnedAlerts(db, CAR)).length, 1);
});

test('a driver well off the route is not warned', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  await start(db);
  await place(db, CAR, east(40, 400));
  await place(db, AMB, at(0));
  assert.equal((await warnedAlerts(db, CAR)).length, 0);
});

test('a driver the vehicle has already passed is not warned', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  await start(db);
  await place(db, CAR, at(10));
  await place(db, AMB, at(30));
  assert.equal((await warnedAlerts(db, CAR)).length, 0);
});

test('a driver beyond 1.5 km is warned once the vehicle closes in', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  await start(db);
  await place(db, CAR, at(78)); // ~1940 m ahead
  await place(db, AMB, at(0));
  assert.equal((await warnedAlerts(db, CAR)).length, 0);

  await place(db, AMB, at(30));
  assert.equal((await warnedAlerts(db, CAR)).length, 1);
});

// A phone that stopped reporting ten minutes ago says nothing about where
// that car is now.
test('a vehicle with a stale position is not warned', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  await start(db);
  await place(db, CAR, east(40, 50), '10 minutes');
  await place(db, AMB, at(0));
  assert.equal((await warnedAlerts(db, CAR)).length, 0);
});

test('every driver ahead is warned, each to their own vehicle', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  await start(db);
  await place(db, CAR, east(20, 30));
  await place(db, CAR2, east(50, -30));
  await place(db, AMB, at(0));
  assert.equal((await warnedAlerts(db, CAR)).length, 1);
  assert.equal((await warnedAlerts(db, CAR2)).length, 1);
});

// An ambulance on a call is expected to exceed the limit; beeping at the
// medic about it would be a distraction at the worst possible time.
test('the corridor vehicle is not beeped for overspeeding', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  await start(db);
  await db.query(
    `insert into public.vehicle_positions (vehicle_id, lat, lng, speed, heading) values ($1, $2, $3, 110, 0)`,
    [AMB, ...at(0)],
  );
  const { rows } = await db.query(
    `select count(*)::int as n from public.alerts where vehicle_id = $1 and category = 'RULE'`,
    [AMB],
  );
  assert.equal(rows[0].n, 0);
  const { rows: v } = await db.query(`select count(*)::int as n from public.violations where vehicle_id = $1`, [AMB]);
  assert.equal(v[0].n, 1, 'the violation is still on record');
});

// --- Ending ---------------------------------------------------------------

test('arriving at the destination ends the corridor', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  const id = await start(db);
  await place(db, AMB, at(80));
  assert.equal(await status(db, id), 'ENDED');
});

test('the owner can end a corridor by hand', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  const id = await start(db);
  await db.query(`select public.end_corridor($1)`, [id]);
  assert.equal(await status(db, id), 'ENDED');
});

test('another driver cannot end it', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  const id = await start(db);
  await claim(db, DRIVER);
  await rejects(() => db.query(`select public.end_corridor($1)`, [id]), { code: '42501' });
});

test('an ended corridor no longer warns or moves signals', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  const id = await start(db);
  await db.query(`select public.end_corridor($1)`, [id]);
  await place(db, CAR, east(40, 50));
  await place(db, AMB, at(20));
  assert.deepEqual(await states(db, id), ['WAITING', 'WAITING', 'WAITING']);
  assert.equal((await warnedAlerts(db, CAR)).length, 0);
});

test('an expired corridor is ignored', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  const id = await start(db);
  await db.query(`update public.corridors set expires_at = now() - interval '1 minute' where id = $1`, [id]);
  await place(db, AMB, at(20));
  assert.deepEqual(await states(db, id), ['WAITING', 'WAITING', 'WAITING']);
});

// --- Who sees what -------------------------------------------------------

async function seeded() {
  const db = await setup();
  await claim(db, MEDIC);
  await start(db);
  await place(db, CAR, east(40, 50));
  await place(db, AMB, at(0));
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  return db;
}

const visible = async (db, userId) =>
  asUser(db, userId, async () => {
    const count = async (table) =>
      (await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n;
    return {
      corridors: await count('corridors'),
      signals: await count('corridor_signals'),
      points: await count('corridor_route_points'),
      warnings: await count('corridor_warnings'),
    };
  });

test('the medic sees their corridor, its route and its signals', async () => {
  const db = await seeded();
  const v = await visible(db, MEDIC);
  assert.equal(v.corridors, 1);
  assert.equal(v.signals, 3);
  assert.equal(v.points, 81);
});

test('an operator sees every corridor and every warning', async () => {
  const db = await seeded();
  const v = await visible(db, OPERATOR);
  assert.equal(v.corridors, 1);
  assert.equal(v.warnings, 1);
});

test('another driver sees no corridor, only the warning to their own vehicle', async () => {
  const db = await seeded();
  const v = await visible(db, DRIVER);
  assert.equal(v.corridors, 0);
  assert.equal(v.signals, 0);
  assert.equal(v.warnings, 1);
});

test('a client cannot write a corridor or its signals directly', async () => {
  const db = await setup();
  await asUser(db, MEDIC, async () => {
    await rejects(() =>
      db.query(
        `insert into public.corridors (vehicle_id, destination_lat, destination_lng) values ($1, 12.98, 77.59)`,
        [AMB],
      ),
    );
  });
});

test('a client cannot turn a signal green by hand', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  const id = await start(db);
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  await asUser(db, MEDIC, async () => {
    await db.query(`update public.corridor_signals set state = 'GREEN' where corridor_id = $1`, [id]);
  });
  assert.deepEqual(await states(db, id), ['WAITING', 'WAITING', 'WAITING']);
});

test('the RPCs work through RLS as a real client', async () => {
  const db = await setup();
  await asUser(db, MEDIC, async () => {
    const id = await start(db);
    await db.query(`select public.end_corridor($1)`, [id]);
    const { rows } = await db.query(`select status from public.corridors where id = $1`, [id]);
    assert.equal(rows[0].status, 'ENDED');
  });
});

// --- Retention ------------------------------------------------------------

test('ended corridors are pruned after the retention window', async () => {
  const db = await setup();
  await claim(db, MEDIC);
  const id = await start(db);
  await db.query(
    `update public.corridors set status = 'ENDED', ended_at = now() - interval '40 days',
            started_at = now() - interval '40 days' where id = $1`,
    [id],
  );
  const live = await start(db);
  await db.query('select * from public.prune_old_data()');
  const { rows } = await db.query('select id from public.corridors');
  assert.deepEqual(rows.map((r) => r.id), [live]);
});
