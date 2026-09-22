import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedUsers } from './harness.mjs';

const DRIVER = '11111111-1111-1111-1111-111111111111';
const VEH = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function setup() {
  const db = await freshDb();
  await seedUsers(db, [{ id: DRIVER, email: 'a@x.com' }]);
  await db.query(
    `insert into public.vehicles (id, owner, vehicle_number, driver_name)
     values ($1,$2,'KA-03-AB-1234','A')`,
    [VEH, DRIVER],
  );
  return db;
}

const prune = (db) => db.query('select * from public.prune_old_data()');

test('history older than the window is pruned', async () => {
  const db = await setup();
  await db.query(
    `insert into public.position_history (vehicle_id, lat, lng, speed, heading, recorded_at)
     values ($1,1,1,10,0, now() - interval '31 days'),
            ($1,1,1,10,0, now() - interval '2 days')`,
    [VEH],
  );
  await prune(db);
  const { rows } = await db.query('select count(*)::int as n from public.position_history');
  assert.equal(rows[0].n, 1, 'recent history survives');
});

test('prune reports what it removed', async () => {
  const db = await setup();
  await db.query(
    `insert into public.position_history (vehicle_id, lat, lng, speed, heading, recorded_at)
     values ($1,1,1,10,0, now() - interval '40 days')`,
    [VEH],
  );
  const { rows } = await prune(db);
  const history = rows.find((r) => r.pruned_table === 'position_history');
  assert.equal(Number(history.removed), 1);
});

// An old row for a vehicle that is speeding right now is not stale data.
test('an open violation is never pruned however old', async () => {
  const db = await setup();
  await db.query(
    `insert into public.violations (vehicle_id, speed, speed_limit, lat, lng, occurred_at, cleared_at)
     values ($1, 95, 80, 1, 1, now() - interval '400 days', null)`,
    [VEH],
  );
  await prune(db);
  const { rows } = await db.query('select count(*)::int as n from public.violations');
  assert.equal(rows[0].n, 1);
});

test('a closed violation past the window is pruned', async () => {
  const db = await setup();
  await db.query(
    `insert into public.violations (vehicle_id, speed, speed_limit, lat, lng, occurred_at, cleared_at)
     values ($1, 95, 80, 1, 1, now() - interval '400 days', now() - interval '399 days')`,
    [VEH],
  );
  await prune(db);
  const { rows } = await db.query('select count(*)::int as n from public.violations');
  assert.equal(rows[0].n, 0);
});

test('windows are data, not hardcoded in the function', async () => {
  const db = await setup();
  await db.query(`update public.retention_policy set keep_days = 1 where table_name = 'position_history'`);
  await db.query(
    `insert into public.position_history (vehicle_id, lat, lng, speed, heading, recorded_at)
     values ($1,1,1,10,0, now() - interval '2 days')`,
    [VEH],
  );
  await prune(db);
  const { rows } = await db.query('select count(*)::int as n from public.position_history');
  assert.equal(rows[0].n, 0, 'shortening the window takes effect without a code change');
});

test('pruning an empty database is harmless', async () => {
  const db = await setup();
  const { rows } = await prune(db);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => Number(r.removed) === 0));
});
