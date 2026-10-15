// Removing simulated vehicles, without opening a way to erase a real record.
//
// Vehicles have no delete policy on purpose: deleting one cascades to its
// history and violations, so a driver able to delete their own vehicle could
// wipe their record. Only this narrow path removes anything.

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedUsers, asUser, rejects } from './harness.mjs';

const OPS = '33333333-3333-3333-3333-333333333333';
const OTHER_OPS = '44444444-4444-4444-4444-444444444444';
const DRIVER = '11111111-1111-1111-1111-111111111111';

async function setup() {
  const db = await freshDb();
  await seedUsers(db, [
    { id: OPS, email: 'ops@x.com' },
    { id: OTHER_OPS, email: 'ops2@x.com' },
    { id: DRIVER, email: 'd@x.com' },
  ]);
  await db.query(`insert into public.operators (user_id) values ($1), ($2)`, [OPS, OTHER_OPS]);
  await db.query(
    `insert into public.vehicles (owner, vehicle_number, driver_name) values
       ($1, 'SIM 0001', 'Simulated'),
       ($1, 'SIM 0002', 'Simulated (speeding)'),
       ($1, 'DL 01 AA 0001', 'Real driver'),
       ($1, 'SIM 9999', 'A real car someone plated SIM'),
       ($2, 'SIM 0001X', 'Simulated'),
       ($3, 'SIM 0003', 'Simulated')`,
    [OPS, OTHER_OPS, DRIVER],
  );
  return db;
}

const plates = async (db) =>
  (await db.query(`select vehicle_number from public.vehicles order by vehicle_number`)).rows.map((r) => r.vehicle_number);

test('an operator removes their own simulated vehicles, and only those', async () => {
  const db = await setup();
  await asUser(db, OPS, async () => {
    const { rows } = await db.query(`select public.remove_simulated_vehicles() as n`);
    assert.equal(rows[0].n, 2);
    await db.exec('commit; begin');
  });
  // Their real vehicle, a real car that merely has a SIM-like plate, and
  // everyone else's vehicles all survive.
  assert.deepEqual(await plates(db), ['DL 01 AA 0001', 'SIM 0001X', 'SIM 0003', 'SIM 9999']);
});

test('a driver cannot use it', async () => {
  const db = await setup();
  await asUser(db, DRIVER, () => rejects(() => db.query(`select public.remove_simulated_vehicles()`), { code: '42501' }));
  assert.equal((await plates(db)).length, 6);
});

// The rule this exists to protect.
test('a driver still cannot delete a vehicle directly', async () => {
  const db = await setup();
  await asUser(db, DRIVER, async () => {
    await db.query(`delete from public.vehicles`);
    await db.exec('commit; begin');
  });
  assert.equal((await plates(db)).length, 6);
});

test('anonymous visitors cannot reach it', async () => {
  const db = await setup();
  const { rows } = await db.query(
    `select has_function_privilege('anon', 'public.remove_simulated_vehicles()', 'execute') as anon`,
  );
  assert.equal(rows[0].anon, false);
});
