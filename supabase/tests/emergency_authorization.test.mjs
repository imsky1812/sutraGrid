// Granting emergency authorization from the operator console.
//
// The anti-escalation trigger blocks the `authenticated` role from touching
// is_emergency_authorized at all, so the console goes through an RPC that
// checks operator membership and records who granted what.

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedUsers, asUser, rejects } from './harness.mjs';

const DRIVER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const OPERATOR = '33333333-3333-3333-3333-333333333333';
const VEH = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MISSING = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

async function setup() {
  const db = await freshDb();
  await seedUsers(db, [
    { id: DRIVER, email: 'a@x.com' },
    { id: OTHER, email: 'b@x.com' },
    { id: OPERATOR, email: 'ops@x.com' },
  ]);
  await db.query(
    `insert into public.vehicles (id, owner, vehicle_number, driver_name)
     values ($1, $2, 'UP 32 G 6789', 'Driver')`,
    [VEH, DRIVER],
  );
  await db.query(`insert into public.operators (user_id) values ($1)`, [OPERATOR]);
  return db;
}

const grant = (db, authorized, type = null, vehicle = VEH) =>
  db.query(`select public.set_emergency_authorization($1, $2, $3)`, [vehicle, authorized, type]);

const vehicle = async (db) =>
  (
    await db.query(
      `select is_emergency_authorized as authorized, vehicle_type from public.vehicles where id = $1`,
      [VEH],
    )
  ).rows[0];

test('an operator can authorize a vehicle', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    await grant(db, true, 'AMBULANCE');
    assert.deepEqual(await vehicle(db), { authorized: true, vehicle_type: 'AMBULANCE' });
  });
});

test('an operator can revoke it again', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    await grant(db, true, 'AMBULANCE');
    await grant(db, false);
    assert.equal((await vehicle(db)).authorized, false);
  });
});

// Without the type argument the vehicle keeps the type it had.
test('the vehicle type is left alone when not given', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    await grant(db, true);
    assert.equal((await vehicle(db)).vehicle_type, 'NORMAL');
  });
});

test('a driver cannot authorize their own vehicle', async () => {
  const db = await setup();
  await asUser(db, DRIVER, () => rejects(() => grant(db, true, 'AMBULANCE'), { code: '42501' }));
  assert.equal((await vehicle(db)).authorized, false);
});

test('another signed-in user cannot authorize someone else', async () => {
  const db = await setup();
  await asUser(db, OTHER, () => rejects(() => grant(db, true), { code: '42501' }));
});

test('an unknown vehicle is reported, not silently ignored', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, () =>
    rejects(() => grant(db, true, null, MISSING), { message: 'No such vehicle' }),
  );
});

test('an invalid vehicle type is refused', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, () => rejects(() => grant(db, true, 'TANK')));
});

// The whole point of the flag is that it is granted deliberately by a named
// person, so who did it has to be on record.
test('every change is recorded against the operator who made it', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    await grant(db, true, 'AMBULANCE');
    await grant(db, false);
    const { rows } = await db.query(
      `select granted_by, authorized, vehicle_type from public.emergency_grants
        where vehicle_id = $1 order by id`,
      [VEH],
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].granted_by, OPERATOR);
    assert.equal(rows[0].authorized, true);
    assert.equal(rows[0].vehicle_type, 'AMBULANCE');
    assert.equal(rows[1].authorized, false);
  });
});

test('an operator reads the grant history; a driver does not', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    await grant(db, true);
    await db.exec('commit; begin');
  });
  await asUser(db, OPERATOR, async () => {
    const { rows } = await db.query('select id from public.emergency_grants');
    assert.equal(rows.length, 1);
  });
  await asUser(db, DRIVER, async () => {
    const { rows } = await db.query('select id from public.emergency_grants');
    assert.equal(rows.length, 0);
  });
});

test('the history cannot be written directly by a client', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    await rejects(() =>
      db.query(
        `insert into public.emergency_grants (vehicle_id, granted_by, authorized)
         values ($1, $2, true)`,
        [VEH, OPERATOR],
      ),
    );
  });
});

// The trigger that stops a driver flipping the flag has to stay in force.
test('the flag still cannot be changed by a direct update', async () => {
  const db = await setup();
  await asUser(db, DRIVER, () =>
    rejects(
      () =>
        db.query(`update public.vehicles set is_emergency_authorized = true where id = $1`, [VEH]),
      { code: 'P0001' },
    ),
  );
});

test('anonymous visitors cannot reach the RPC', async () => {
  const db = await setup();
  const { rows } = await db.query(
    `select has_function_privilege('anon', 'public.set_emergency_authorization(uuid, boolean, text)', 'execute') as anon,
            has_function_privilege('authenticated', 'public.set_emergency_authorization(uuid, boolean, text)', 'execute') as auth`,
  );
  assert.deepEqual(rows[0], { anon: false, auth: true });
});
