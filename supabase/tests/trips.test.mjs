// Grouping the position stream into trips.
//
// The case that motivated how this is built: a parked phone keeps streaming,
// and GPS wanders a few metres per fix, so naive summing reports kilometres
// "driven" while the car sat still. Those tests come first.

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedUsers, asUser } from './harness.mjs';

const ME = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const OPS = '33333333-3333-3333-3333-333333333333';
const CAR = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const LAT = 28.6139;
const LNG = 77.209;
/** Metres north of the start, in degrees. */
const north = (m) => LAT + m / 110540;

async function setup() {
  const db = await freshDb();
  await seedUsers(db, [
    { id: ME, email: 'me@x.com' },
    { id: OTHER, email: 'other@x.com' },
    { id: OPS, email: 'ops@x.com' },
  ]);
  await db.query(
    `insert into public.vehicles (id, owner, vehicle_number, driver_name) values ($1, $2, 'DL 01 AA 0001', 'Me')`,
    [CAR, ME],
  );
  await db.query(`insert into public.operators (user_id) values ($1)`, [OPS]);
  return db;
}

/**
 * Record a drive: `count` points, `stepM` metres apart, `everyS` seconds apart,
 * starting `agoMin` minutes ago, at `speed` km/h.
 */
async function drive(db, { agoMin, count, stepM = 25, everyS = 3, speed = 30, startM = 0, jitter = 0 }) {
  for (let i = 0; i < count; i++) {
    const wobble = jitter ? (i % 2 ? jitter : -jitter) : 0;
    await db.query(
      `insert into public.position_history (vehicle_id, lat, lng, speed, heading, recorded_at)
       values ($1, $2, $3, $4, 0, now() - make_interval(mins => $5) + make_interval(secs => $6))`,
      [CAR, north(startM + i * stepM + wobble), LNG, speed, agoMin, i * everyS],
    );
  }
}

const trips = async (db, days = 7) =>
  (await db.query(`select * from public.vehicle_trips($1, $2)`, [CAR, days])).rows;

test('one continuous drive is one trip, measured along its path', async () => {
  const db = await setup();
  await drive(db, { agoMin: 60, count: 41, stepM: 25 }); // 1 km

  await asUser(db, ME, async () => {
    const [t] = await trips(db);
    assert.ok(Math.abs(t.distance_m - 1000) < 5, `${t.distance_m} m`);
    assert.equal(t.points, 41);
    assert.equal(Math.round(t.top_speed), 30);
  });
});

// The reason trips are built from moving points only.
test('a parked phone wobbling for an hour drives nowhere', async () => {
  const db = await setup();
  // An hour of fixes every 3 s, 6 m of GPS wobble each, speed reported 0.
  await drive(db, { agoMin: 120, count: 1200, stepM: 0, speed: 0, jitter: 6 });

  await asUser(db, ME, async () => {
    assert.deepEqual(await trips(db), []);
  });
});

test('a stop longer than five minutes ends one trip and starts another', async () => {
  const db = await setup();
  await drive(db, { agoMin: 90, count: 41 }); // ends ~88 min ago
  await drive(db, { agoMin: 60, count: 41, startM: 1000 }); // 28 min later

  await asUser(db, ME, async () => {
    const rows = await trips(db);
    assert.equal(rows.length, 2);
    // Newest first.
    assert.ok(rows[0].started_at > rows[1].started_at);
  });
});

test('a short pause at a junction does not split the trip', async () => {
  const db = await setup();
  await drive(db, { agoMin: 60, count: 20 });
  await drive(db, { agoMin: 57, count: 20, startM: 500 }); // ~2 min later

  await asUser(db, ME, async () => {
    assert.equal((await trips(db)).length, 1);
  });
});

test('a blip of movement in a car park is not a journey', async () => {
  const db = await setup();
  await drive(db, { agoMin: 30, count: 3, stepM: 20 }); // 40 m

  await asUser(db, ME, async () => {
    assert.deepEqual(await trips(db), []);
  });
});

test('speeding during a trip is counted against it', async () => {
  const db = await setup();
  await drive(db, { agoMin: 60, count: 41 });
  await db.query(
    `insert into public.violations (vehicle_id, speed, speed_limit, lat, lng, occurred_at, cleared_at)
     values ($1, 95, 80, $2, $3, now() - interval '59 minutes', now() - interval '58 minutes')`,
    [CAR, LAT, LNG],
  );
  // One outside any trip, which must not be attributed to it.
  await db.query(
    `insert into public.violations (vehicle_id, speed, speed_limit, lat, lng, occurred_at, cleared_at)
     values ($1, 95, 80, $2, $3, now() - interval '3 hours', now() - interval '3 hours')`,
    [CAR, LAT, LNG],
  );

  await asUser(db, ME, async () => {
    assert.equal((await trips(db))[0].violations, 1);
  });
});

test('trips older than the window are left out', async () => {
  const db = await setup();
  await drive(db, { agoMin: 3 * 24 * 60, count: 41 }); // three days ago

  await asUser(db, ME, async () => {
    assert.equal((await trips(db, 1)).length, 0);
    assert.equal((await trips(db, 7)).length, 1);
  });
});

test('the window is capped at thirty days', async () => {
  const db = await setup();
  await drive(db, { agoMin: 40 * 24 * 60, count: 41 }); // forty days ago

  await asUser(db, ME, async () => {
    assert.equal((await trips(db, 365)).length, 0);
  });
});

// Row-level security does the work: the function runs as the caller.
test('another driver gets nothing for a vehicle that is not theirs', async () => {
  const db = await setup();
  await drive(db, { agoMin: 60, count: 41 });

  await asUser(db, OTHER, async () => {
    assert.deepEqual(await trips(db), []);
  });
});

test('an operator can see any vehicle’s trips', async () => {
  const db = await setup();
  await drive(db, { agoMin: 60, count: 41 });

  await asUser(db, OPS, async () => {
    assert.equal((await trips(db)).length, 1);
  });
});

test('anonymous visitors cannot call it', async () => {
  const db = await setup();
  const { rows } = await db.query(
    `select has_function_privilege('anon', 'public.vehicle_trips(uuid, integer)', 'execute') as anon,
            has_function_privilege('authenticated', 'public.vehicle_trips(uuid, integer)', 'execute') as auth`,
  );
  assert.deepEqual(rows[0], { anon: false, auth: true });
});
