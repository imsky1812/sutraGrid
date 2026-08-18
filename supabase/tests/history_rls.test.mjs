import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedUsers, asUser, rejects } from './harness.mjs';

const DRIVER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const OPERATOR = '33333333-3333-3333-3333-333333333333';
const VEH_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VEH_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function setup() {
  const db = await freshDb();
  await seedUsers(db, [
    { id: DRIVER, email: 'a@x.com' },
    { id: OTHER, email: 'b@x.com' },
    { id: OPERATOR, email: 'ops@x.com' },
  ]);
  await db.query(
    `insert into public.vehicles (id, owner, vehicle_number, driver_name)
     values ($1,$2,'KA-03-AB-1234','A'), ($3,$4,'KA-03-CD-5678','B')`,
    [VEH_A, DRIVER, VEH_B, OTHER],
  );
  await db.query(`insert into public.operators (user_id) values ($1)`, [OPERATOR]);
  return db;
}

const push = (db, vehicleId, speed) =>
  db.query(
    `insert into public.vehicle_positions (vehicle_id, lat, lng, speed, heading)
     values ($1, 12.9716, 77.5946, $2, 90)
     on conflict (vehicle_id) do update set speed = excluded.speed, updated_at = now()`,
    [vehicleId, speed],
  );

// vehicle_positions overwrites itself, so without the trigger there would be
// nothing to show a driver for last Tuesday.
test('every position upsert appends a history row', async () => {
  const db = await setup();
  await push(db, VEH_A, 30);
  await push(db, VEH_A, 40);
  await push(db, VEH_A, 50);

  const { rows } = await db.query(
    'select speed from public.position_history where vehicle_id = $1 order by id',
    [VEH_A],
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => Number(r.speed)), [30, 40, 50]);

  const live = await db.query('select count(*)::int as n from public.vehicle_positions');
  assert.equal(live.rows[0].n, 1, 'live table still holds one row per vehicle');
});

test('a driver reads only their own history', async () => {
  const db = await setup();
  await push(db, VEH_A, 30);
  await push(db, VEH_B, 30);
  await asUser(db, DRIVER, async () => {
    const { rows } = await db.query('select vehicle_id from public.position_history');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].vehicle_id, VEH_A);
  });
});

test('an operator reads all history', async () => {
  const db = await setup();
  await push(db, VEH_A, 30);
  await push(db, VEH_B, 30);
  await asUser(db, OPERATOR, async () => {
    const { rows } = await db.query('select vehicle_id from public.position_history');
    assert.equal(rows.length, 2);
  });
});

test('history cannot be written directly by a client', async () => {
  const db = await setup();
  await asUser(db, DRIVER, async () => {
    await rejects(
      () =>
        db.query(
          `insert into public.position_history (vehicle_id, lat, lng, speed, heading)
           values ($1, 1, 1, 0, 0)`,
          [VEH_A],
        ),
      { code: '42501' },
    );
  });
});

// One episode, not one row per frame.
test('sustained speeding records a single open violation', async () => {
  const db = await setup();
  await push(db, VEH_A, 95);
  await push(db, VEH_A, 101);
  await push(db, VEH_A, 98);

  const { rows } = await db.query(
    'select speed, cleared_at from public.violations where vehicle_id = $1',
    [VEH_A],
  );
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].speed), 101, 'keeps the worst speed of the episode');
  assert.equal(rows[0].cleared_at, null);
});

test('dropping clear of the limit closes the violation', async () => {
  const db = await setup();
  await push(db, VEH_A, 95);
  await push(db, VEH_A, 60);

  const { rows } = await db.query('select cleared_at from public.violations where vehicle_id = $1', [VEH_A]);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].cleared_at, null);
});

// Hysteresis: hovering at the limit must not open and close repeatedly.
test('hovering just below the limit does not close the episode', async () => {
  const db = await setup();
  await push(db, VEH_A, 95);
  await push(db, VEH_A, 78);

  const { rows } = await db.query('select cleared_at from public.violations where vehicle_id = $1', [VEH_A]);
  assert.equal(rows[0].cleared_at, null);
});

test('a second episode opens after the first clears', async () => {
  const db = await setup();
  await push(db, VEH_A, 95);
  await push(db, VEH_A, 40);
  await push(db, VEH_A, 90);

  const { rows } = await db.query('select count(*)::int as n from public.violations where vehicle_id = $1', [VEH_A]);
  assert.equal(rows[0].n, 2);
});

test('driving under the limit records no violation', async () => {
  const db = await setup();
  await push(db, VEH_A, 55);
  const { rows } = await db.query('select count(*)::int as n from public.violations');
  assert.equal(rows[0].n, 0);
});

test('a violation records where it happened', async () => {
  const db = await setup();
  await push(db, VEH_A, 95);
  const { rows } = await db.query('select lat, lng, speed_limit from public.violations');
  assert.equal(Number(rows[0].lat), 12.9716);
  assert.equal(Number(rows[0].speed_limit), 80);
});

test('a driver reads only their own violations', async () => {
  const db = await setup();
  await push(db, VEH_A, 95);
  await push(db, VEH_B, 95);
  await asUser(db, DRIVER, async () => {
    const { rows } = await db.query('select vehicle_id from public.violations');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].vehicle_id, VEH_A);
  });
});
