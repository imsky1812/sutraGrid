import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedUsers, asUser } from './harness.mjs';

const DRIVER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const VEH_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VEH_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function setup() {
  const db = await freshDb();
  await seedUsers(db, [
    { id: DRIVER, email: 'a@x.com' },
    { id: OTHER, email: 'b@x.com' },
  ]);
  await db.query(
    `insert into public.vehicles (id, owner, vehicle_number, driver_name)
     values ($1,$2,'KA-03-AB-1234','A'), ($3,$4,'KA-03-CD-5678','B')`,
    [VEH_A, DRIVER, VEH_B, OTHER],
  );
  return db;
}

const push = (db, vehicleId, speed) =>
  db.query(
    `insert into public.vehicle_positions (vehicle_id, lat, lng, speed, heading)
     values ($1, 12.9716, 77.5946, $2, 90)
     on conflict (vehicle_id) do update set speed = excluded.speed, updated_at = now()`,
    [vehicleId, speed],
  );

const alertsFor = (db, vehicleId) =>
  db.query(
    `select category, severity, message, created_by from public.alerts where vehicle_id = $1`,
    [vehicleId],
  );

// The driver is the one who needs to hear about it, not only the operator
// reading a report afterwards.
test('opening a speeding episode alerts that vehicle', async () => {
  const db = await setup();
  await push(db, VEH_A, 95);

  const { rows } = await alertsFor(db, VEH_A);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'RULE');
  assert.equal(rows[0].severity, 'WARNING');
  assert.match(rows[0].message, /95/);
  assert.match(rows[0].message, /80/);
  assert.equal(rows[0].created_by, null, 'raised by the system, not a person');
});

// One beep per episode. A beep every three seconds would be dangerous noise.
test('staying over the limit does not repeat the alert', async () => {
  const db = await setup();
  for (const speed of [95, 100, 110, 98]) await push(db, VEH_A, speed);

  const { rows } = await alertsFor(db, VEH_A);
  assert.equal(rows.length, 1);
});

test('a new episode after slowing down alerts again', async () => {
  const db = await setup();
  for (const speed of [95, 40, 92]) await push(db, VEH_A, speed);

  const { rows } = await alertsFor(db, VEH_A);
  assert.equal(rows.length, 2);
});

test('driving within the limit raises no alert', async () => {
  const db = await setup();
  for (const speed of [30, 60, 79]) await push(db, VEH_A, speed);

  const { rows } = await alertsFor(db, VEH_A);
  assert.equal(rows.length, 0);
});

test('a speeding alert reaches only the speeding driver', async () => {
  const db = await setup();
  await push(db, VEH_A, 95);
  await db.exec('commit; begin');

  await asUser(db, OTHER, async () => {
    const { rows } = await db.query('select id from public.alerts');
    assert.equal(rows.length, 0);
  });
  await asUser(db, DRIVER, async () => {
    const { rows } = await db.query('select id from public.alerts');
    assert.equal(rows.length, 1);
  });
});

// Making created_by nullable must not let a client raise an anonymous alert.
test('a client cannot raise an alert without an author', async () => {
  const db = await setup();
  await db.query(`insert into public.operators (user_id) values ($1)`, [DRIVER]);
  await asUser(db, DRIVER, async () => {
    await assert.rejects(
      db.query(`insert into public.alerts (created_by, vehicle_id, message) values (null, $1, 'x')`, [VEH_A]),
    );
  });
});
