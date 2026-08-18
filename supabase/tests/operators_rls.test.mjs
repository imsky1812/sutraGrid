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
    { id: DRIVER, email: 'driver@example.com' },
    { id: OTHER, email: 'other@example.com' },
    { id: OPERATOR, email: 'ops@example.com' },
  ]);
  await db.query(
    `insert into public.vehicles (id, owner, vehicle_number, driver_name)
     values ($1,$2,'KA-03-AB-1234','Driver A'), ($3,$4,'KA-03-CD-5678','Driver B')`,
    [VEH_A, DRIVER, VEH_B, OTHER],
  );
  await db.query(
    `insert into public.vehicle_positions (vehicle_id, lat, lng, speed, heading)
     values ($1,12.9716,77.5946,42,90), ($2,12.98,77.60,30,45)`,
    [VEH_A, VEH_B],
  );
  await db.query(`insert into public.operators (user_id) values ($1)`, [OPERATOR]);
  return db;
}

test('an operator sees every vehicle position', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    const { rows } = await db.query('select vehicle_id from public.vehicle_positions');
    assert.equal(rows.length, 2);
  });
});

test('an operator sees every vehicle', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    const { rows } = await db.query('select vehicle_number from public.vehicles');
    assert.equal(rows.length, 2);
  });
});

// The whole point of the operator role: without it a signed-in user sees only
// their own rows, which is why the dashboard received nothing before.
test('a driver still sees only their own vehicle', async () => {
  const db = await setup();
  await asUser(db, DRIVER, async () => {
    const { rows } = await db.query('select vehicle_number from public.vehicles');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].vehicle_number, 'KA-03-AB-1234');
  });
});

test('a driver still sees only their own position', async () => {
  const db = await setup();
  await asUser(db, DRIVER, async () => {
    const { rows } = await db.query('select vehicle_id from public.vehicle_positions');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].vehicle_id, VEH_A);
  });
});

// Membership must be granted by an administrator, never self-assigned.
test('a user cannot make themselves an operator', async () => {
  const db = await setup();
  await asUser(db, DRIVER, async () => {
    await rejects(
      () => db.query('insert into public.operators (user_id) values ($1)', [DRIVER]),
      { code: '42501' },
    );
  });
});

test('a user cannot see the operator roster', async () => {
  const db = await setup();
  await asUser(db, DRIVER, async () => {
    const { rows } = await db.query('select user_id from public.operators');
    assert.equal(rows.length, 0);
  });
});

test('an operator can confirm their own membership', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    const { rows } = await db.query('select user_id from public.operators');
    assert.equal(rows.length, 1);
  });
});

// An operator watches; they do not drive. Write access stays owner-only.
test('an operator cannot write another vehicle position', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    await rejects(
      () =>
        db.query(
          `insert into public.vehicle_positions (vehicle_id, lat, lng, speed, heading)
           values ($1, 1, 1, 0, 0)
           on conflict (vehicle_id) do update set lat = 1`,
          [VEH_A],
        ),
      { code: '42501' },
    );
  });
});
