// Positions a phone kept while it had no signal.
//
// The rule that matters: they complete the vehicle's track, and touch
// nothing live. A replay into the live table would move the vehicle
// backwards on every map and run every check on stale data.

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedUsers, asUser, rejects } from './harness.mjs';

const OWNER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const CAR = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function setup() {
  const db = await freshDb();
  await seedUsers(db, [
    { id: OWNER, email: 'o@x.com' },
    { id: OTHER, email: 'x@x.com' },
  ]);
  await db.query(
    `insert into public.vehicles (id, owner, vehicle_number, driver_name) values ($1, $2, 'DL 01 AA 0001', 'D')`,
    [CAR, OWNER],
  );
  return db;
}

/** `n` fixes, one every 3 s, ending `minutesAgo` minutes ago. */
const outage = (n, minutesAgo = 5, extra = {}) =>
  Array.from({ length: n }, (_, i) => ({
    lat: 28.6139 + i * 0.0002,
    lng: 77.209,
    speed: 40,
    heading: 0,
    recorded_at: new Date(Date.now() - minutesAgo * 60_000 - (n - i) * 3000).toISOString(),
    ...extra,
  }));

const send = (db, points, vehicle = CAR) =>
  db.query(`select public.record_buffered_positions($1, $2) as n`, [vehicle, JSON.stringify(points)]);

const history = async (db) =>
  (await db.query(`select count(*)::int as n from public.position_history where vehicle_id = $1`, [CAR])).rows[0].n;

test('a stretch without signal fills in the track', async () => {
  const db = await setup();
  await asUser(db, OWNER, async () => {
    assert.equal((await send(db, outage(20))).rows[0].n, 20);
    await db.exec('commit; begin');
  });
  assert.equal(await history(db), 20);
});

// The reason they do not go through vehicle_positions.
test('nothing live is touched: no position, no violation, no alert', async () => {
  const db = await setup();
  await asUser(db, OWNER, async () => {
    await send(db, outage(20, 5, { speed: 140 })); // speeding, while offline
    await db.exec('commit; begin');
  });
  const live = await db.query(`select count(*)::int as n from public.vehicle_positions`);
  const violations = await db.query(`select count(*)::int as n from public.violations`);
  const alerts = await db.query(`select count(*)::int as n from public.alerts`);
  assert.deepEqual(
    [live.rows[0].n, violations.rows[0].n, alerts.rows[0].n],
    [0, 0, 0],
  );
});

test('sending the same batch twice keeps it once', async () => {
  const db = await setup();
  const batch = outage(10);
  await asUser(db, OWNER, async () => {
    await send(db, batch);
    assert.equal((await send(db, batch)).rows[0].n, 0);
    await db.exec('commit; begin');
  });
  assert.equal(await history(db), 10);
});

test('positions from the future, or from too long ago, are skipped', async () => {
  const db = await setup();
  const future = outage(3, -10); // ten minutes ahead
  const ancient = outage(3, 13 * 60); // thirteen hours ago
  await asUser(db, OWNER, async () => {
    assert.equal((await send(db, [...future, ...ancient, ...outage(2)])).rows[0].n, 2);
  });
});

// One bad point must not throw away the rest of an outage.
test('malformed points are skipped and the rest kept', async () => {
  const db = await setup();
  const good = outage(3);
  const bad = [
    { lat: 'x', lng: 77, recorded_at: good[0].recorded_at },
    { lat: 95, lng: 77, recorded_at: new Date().toISOString() },
    { lat: 28.6, lng: 77.2, speed: 'fast', recorded_at: new Date().toISOString() },
    { lat: 28.6, lng: 77.2, recorded_at: 'yesterday-ish' },
    { lat: 28.6, lng: 77.2 },
  ];
  await asUser(db, OWNER, async () => {
    assert.equal((await send(db, [...bad, ...good])).rows[0].n, 3);
  });
});

test('only for a vehicle the caller owns', async () => {
  const db = await setup();
  await asUser(db, OTHER, () => rejects(() => send(db, outage(3)), { code: '42501' }));
});

test('one call is bounded', async () => {
  const db = await setup();
  await asUser(db, OWNER, () => rejects(() => send(db, outage(501)), { code: '22023' }));
});

test('it shows up in trips, as the stretch it was', async () => {
  const db = await setup();
  await asUser(db, OWNER, async () => {
    await send(db, outage(40, 10));
    await db.exec('commit; begin');
  });
  await asUser(db, OWNER, async () => {
    const { rows } = await db.query(`select points from public.vehicle_trips($1, 1)`, [CAR]);
    assert.equal(rows[0].points, 40);
  });
});

test('anonymous visitors cannot reach it', async () => {
  const db = await setup();
  const { rows } = await db.query(
    `select has_function_privilege('anon', 'public.record_buffered_positions(uuid, jsonb)', 'execute') as anon`,
  );
  assert.equal(rows[0].anon, false);
});
