// Collision warning for crossing paths.
//
// The tests that matter most are the ones that must stay SILENT. Phone GPS
// cannot tell adjacent lanes apart, so a warning that fires on every oncoming
// car or every overtake would teach drivers to ignore it within a day.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedUsers } from './harness.mjs';

const OWNER = '11111111-1111-1111-1111-111111111111';
const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// The junction everyone is heading for.
const J_LAT = 28.6139;
const J_LNG = 77.209;
const M_LAT = 110540;
const M_LNG = 111320 * Math.cos((J_LAT * Math.PI) / 180);
/** A point `north` metres north and `east` metres east of the junction. */
const at = (north, east) => [J_LAT + north / M_LAT, J_LNG + east / M_LNG];

async function setup() {
  const db = await freshDb();
  await seedUsers(db, [{ id: OWNER, email: 'o@x.com' }]);
  await db.query(
    `insert into public.vehicles (id, owner, vehicle_number, driver_name) values
       ($1, $3, 'DL 01 AA 0001', 'A'), ($2, $3, 'DL 01 AA 0002', 'B')`,
    [A, B, OWNER],
  );
  return db;
}

/** Report a position, through the same table the app writes to. */
const report = (db, vehicle, [lat, lng], speed, heading, ageSeconds = 0) =>
  db.query(
    `insert into public.vehicle_positions (vehicle_id, lat, lng, speed, heading, updated_at)
     values ($1, $2, $3, $4, $5, now() - make_interval(secs => $6))
     on conflict (vehicle_id) do update
       set lat = excluded.lat, lng = excluded.lng, speed = excluded.speed,
           heading = excluded.heading, updated_at = excluded.updated_at`,
    [vehicle, lat, lng, speed, heading, ageSeconds],
  );

const warnings = async (db) =>
  (
    await db.query(
      `select vehicle_id, category, severity, message, extract(epoch from expires_at - created_at)::integer as lasts
         from public.alerts where category = 'HAZARD' order by vehicle_id`,
    )
  ).rows;

describe('crossing paths', () => {
  // A heads north and B heads east; both are 40 m and 4 s from the junction.
  const collisionCourse = async (db) => {
    await report(db, A, at(-40, 0), 36, 0);
    await report(db, B, at(0, -40), 36, 90);
  };

  test('both drivers are warned', async () => {
    const db = await setup();
    await collisionCourse(db);
    const w = await warnings(db);
    assert.equal(w.length, 2);
    assert.deepEqual(w.map((x) => x.vehicle_id).sort(), [A, B]);
    assert.ok(w.every((x) => x.severity === 'CRITICAL'));
  });

  // "From your left" is the useful part: it says where to look.
  test('each is told which side the danger is coming from', async () => {
    const db = await setup();
    await collisionCourse(db);
    const [toA, toB] = await warnings(db);
    // A, heading north, has B approaching from the west: its left.
    assert.match(toA.message, /from your left/);
    // B, heading east, has A approaching from the south: its right.
    assert.match(toB.message, /from your right/);
    assert.match(toA.message, /about 4 s away/);
  });

  // The danger is a few seconds wide. A warning still showing a minute later
  // would be about a junction long since passed.
  test('the warning is short-lived', async () => {
    const db = await setup();
    await collisionCourse(db);
    const [w] = await warnings(db);
    assert.equal(w.lasts, 60);
  });

  test('once per encounter, not on every position', async () => {
    const db = await setup();
    await collisionCourse(db);
    // Two seconds on, still converging.
    await report(db, A, at(-20, 0), 36, 0);
    await report(db, B, at(0, -20), 36, 90);
    assert.equal((await warnings(db)).length, 2);
  });

  test('a later encounter after the cooldown is warned again', async () => {
    const db = await setup();
    await collisionCourse(db);
    await db.query(`update public.conflict_warnings set warned_at = now() - interval '5 minutes'`);
    await report(db, A, at(-40, 0), 36, 0);
    await report(db, B, at(0, -40), 36, 90);
    assert.equal((await warnings(db)).length, 4);
  });
});

describe('staying quiet', () => {
  // Opposing traffic on a two-lane road passes 4 m apart, every time.
  test('an oncoming car in the other lane', async () => {
    const db = await setup();
    await report(db, A, at(-40, 2), 50, 0);
    await report(db, B, at(40, -2), 50, 180);
    assert.deepEqual(await warnings(db), []);
  });

  test('a faster car overtaking in the next lane', async () => {
    const db = await setup();
    await report(db, A, at(0, 0), 30, 0);
    await report(db, B, at(-15, 3.5), 70, 0);
    assert.deepEqual(await warnings(db), []);
  });

  test('two vehicles that have already crossed and are moving apart', async () => {
    const db = await setup();
    await report(db, A, at(30, 0), 36, 0);
    await report(db, B, at(0, 30), 36, 90);
    assert.deepEqual(await warnings(db), []);
  });

  test('a crossing that is still twenty seconds away', async () => {
    const db = await setup();
    await report(db, A, at(-200, 0), 36, 0);
    await report(db, B, at(0, -200), 36, 90);
    assert.deepEqual(await warnings(db), []);
  });

  test('paths that cross, but well apart in time', async () => {
    const db = await setup();
    // A reaches the junction in 4 s, B in 8 s: B passes 40 m behind A.
    await report(db, A, at(-40, 0), 36, 0);
    await report(db, B, at(0, -80), 36, 90);
    assert.deepEqual(await warnings(db), []);
  });

  // Braking is the driver already responding; warning them at every red
  // light would make the feature useless.
  test('a driver who is already braking', async () => {
    const db = await setup();
    await report(db, B, at(0, -40), 36, 90);
    await report(db, A, at(-60, 0), 60, 0);
    await db.query(`delete from public.alerts`);
    await report(db, A, at(-40, 0), 36, 0); // was 60, now 36: braking hard
    assert.deepEqual(await warnings(db), []);
  });

  test('a vehicle crawling or parked at the junction', async () => {
    const db = await setup();
    await report(db, A, at(-10, 0), 4, 0);
    await report(db, B, at(0, -40), 36, 90);
    assert.deepEqual(await warnings(db), []);
  });

  // A position that old is a guess; acting on it would warn about a car that
  // has long since gone.
  test('a vehicle whose last position is stale', async () => {
    const db = await setup();
    await report(db, A, at(-40, 0), 36, 0, 30);
    await report(db, B, at(0, -40), 36, 90);
    assert.deepEqual(await warnings(db), []);
  });
});

test('the thresholds are settings, so they can be tuned without a deploy', async () => {
  const db = await setup();
  await db.query(`update public.settings set value = '2' where key = 'conflict_horizon_s'`);
  // Four seconds out is now beyond the horizon.
  await report(db, A, at(-40, 0), 36, 0);
  await report(db, B, at(0, -40), 36, 90);
  assert.deepEqual(await warnings(db), []);
});

describe('geometry', () => {
  test('bearing reads as a compass', async () => {
    const db = await setup();
    const [n] = at(100, 0);
    const [, e] = at(0, 100);
    const { rows } = await db.query(
      `select round(public.bearing_deg($1, $2, $3, $2)::numeric) as north,
              round(public.bearing_deg($1, $2, $1, $4)::numeric) as east`,
      [J_LAT, J_LNG, n, e],
    );
    assert.deepEqual(rows[0], { north: '0', east: '90' });
  });

  test('sides read from the driver’s seat', async () => {
    const db = await setup();
    const { rows } = await db.query(`
      select public.relative_side(0, 0) as ahead,
             public.relative_side(0, 90) as right_side,
             public.relative_side(0, 180) as behind,
             public.relative_side(0, 270) as left_side,
             public.relative_side(350, 10) as wraps`);
    assert.deepEqual(rows[0], {
      ahead: 'ahead',
      right_side: 'from your right',
      behind: 'from behind',
      left_side: 'from your left',
      wraps: 'ahead',
    });
  });
});

test('nothing here is callable by a client', async () => {
  const db = await setup();
  const { rows } = await db.query(`
    select has_function_privilege('authenticated', 'public.detect_conflicts()', 'execute') as detect,
           has_function_privilege('anon', 'public.setting_num(text, double precision)', 'execute') as setting`);
  assert.deepEqual(rows[0], { detect: false, setting: false });
});

// It runs inside every phone's position update. If it ever breaks, tracking
// must carry on regardless.
test('a failure in the check never blocks a position', async () => {
  const db = await setup();
  // Sabotage a setting so the check throws a cast error.
  await db.query(`update public.settings set value = '"not a number"' where key = 'conflict_miss_m'`);
  await report(db, A, at(-40, 0), 36, 0);
  await report(db, B, at(0, -40), 36, 90);
  const { rows } = await db.query(`select count(*)::int as n from public.vehicle_positions`);
  assert.equal(rows[0].n, 2);
});
