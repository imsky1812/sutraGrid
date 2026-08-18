import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedUsers, asUser, rejects } from './harness.mjs';

const DRIVER_A = '11111111-1111-1111-1111-111111111111';
const DRIVER_B = '22222222-2222-2222-2222-222222222222';

async function setup() {
  const db = await freshDb();
  await seedUsers(db, [
    { id: DRIVER_A, email: 'driver.a@example.com' },
    { id: DRIVER_B, email: 'driver.b@example.com' },
  ]);
  return db;
}

test('a driver can register a vehicle they own', async () => {
  const db = await setup();
  await asUser(db, DRIVER_A, async () => {
    await db.query(
      `insert into public.vehicles (owner, vehicle_number, driver_name)
       values ($1, 'KA-03-AB-1234', 'Driver A')`,
      [DRIVER_A],
    );
    const { rows } = await db.query(
      `select vehicle_number from public.vehicles where owner = $1`,
      [DRIVER_A],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].vehicle_number, 'KA-03-AB-1234');
  });
});

test('a driver cannot register a vehicle owned by someone else', async () => {
  const db = await setup();
  await asUser(db, DRIVER_A, async () => {
    await rejects(
      () =>
        db.query(
          `insert into public.vehicles (owner, vehicle_number, driver_name)
           values ($1, 'KA-03-XX-9999', 'Not Mine')`,
          [DRIVER_B],
        ),
      { code: '42501' },
    );
  });
});

test('a newly registered vehicle is not emergency authorized', async () => {
  const db = await setup();
  await asUser(db, DRIVER_A, async () => {
    await db.query(
      `insert into public.vehicles (owner, vehicle_number, driver_name)
       values ($1, 'KA-03-AB-1234', 'Driver A')`,
      [DRIVER_A],
    );
    const { rows } = await db.query(
      `select is_emergency_authorized from public.vehicles where owner = $1`,
      [DRIVER_A],
    );
    assert.equal(rows[0].is_emergency_authorized, false);
  });
});

// The security-critical case. If this ever passes silently, any driver can
// grant themselves ambulance priority, which is the exact flaw the shared
// EMERGENCY_CODES scheme had.
test('a driver cannot grant themselves emergency authorization', async () => {
  const db = await setup();
  await asUser(db, DRIVER_A, async () => {
    await db.query(
      `insert into public.vehicles (owner, vehicle_number, driver_name)
       values ($1, 'KA-03-AB-1234', 'Driver A')`,
      [DRIVER_A],
    );
    await rejects(
      () =>
        db.query(
          `update public.vehicles set is_emergency_authorized = true
           where owner = $1`,
          [DRIVER_A],
        ),
      { code: 'P0001', message: 'is_emergency_authorized cannot be changed' },
    );
  });
});

// The mirror of the test above: the trigger must block drivers without also
// making the privilege ungrantable. An administrator in the Supabase SQL editor
// runs as `postgres`, and must still be able to authorize a vehicle.
test('an administrator can grant emergency authorization', async () => {
  const db = await setup();
  await asUser(db, DRIVER_A, async () => {
    await db.query(
      `insert into public.vehicles (owner, vehicle_number, driver_name)
       values ($1, 'KA-03-AB-1234', 'Driver A')`,
      [DRIVER_A],
    );
    await db.exec('commit; begin');
  });

  // No `set local role`: this runs as the table owner, like an admin session.
  await db.query(
    `update public.vehicles set is_emergency_authorized = true
     where vehicle_number = 'KA-03-AB-1234'`,
  );
  const { rows } = await db.query(
    `select is_emergency_authorized from public.vehicles
     where vehicle_number = 'KA-03-AB-1234'`,
  );
  assert.equal(rows[0].is_emergency_authorized, true);
});

test('a driver can still update their own non-privileged fields', async () => {
  const db = await setup();
  await asUser(db, DRIVER_A, async () => {
    await db.query(
      `insert into public.vehicles (owner, vehicle_number, driver_name)
       values ($1, 'KA-03-AB-1234', 'Driver A')`,
      [DRIVER_A],
    );
    await db.query(
      `update public.vehicles set driver_name = 'Driver A Renamed' where owner = $1`,
      [DRIVER_A],
    );
    const { rows } = await db.query(
      `select driver_name from public.vehicles where owner = $1`,
      [DRIVER_A],
    );
    assert.equal(rows[0].driver_name, 'Driver A Renamed');
  });
});

test('a driver cannot see another driver vehicles', async () => {
  const db = await setup();
  await asUser(db, DRIVER_A, async () => {
    await db.query(
      `insert into public.vehicles (owner, vehicle_number, driver_name)
       values ($1, 'KA-03-AB-1234', 'Driver A')`,
      [DRIVER_A],
    );
    await db.exec('commit; begin');
  });

  await asUser(db, DRIVER_B, async () => {
    const { rows } = await db.query(`select vehicle_number from public.vehicles`);
    assert.equal(rows.length, 0, 'driver B should see none of driver A vehicles');
  });
});

test('vehicle_type is constrained to the known set', async () => {
  const db = await setup();
  await asUser(db, DRIVER_A, async () => {
    await rejects(
      () =>
        db.query(
          `insert into public.vehicles (owner, vehicle_number, driver_name, vehicle_type)
           values ($1, 'KA-03-AB-1234', 'Driver A', 'TANK')`,
          [DRIVER_A],
        ),
      { code: '23514' },
    );
  });
});
