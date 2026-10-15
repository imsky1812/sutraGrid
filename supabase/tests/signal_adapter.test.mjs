// What SUTRA would ask a city's signal controller, and the rules around it.
//
// Two rules matter most: nothing leaves the system unless an authority has
// switched the adapter on, and a junction is never left held green.

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedUsers, asUser } from './harness.mjs';

const MEDIC = '11111111-1111-1111-1111-111111111111';
const DRIVER = '22222222-2222-2222-2222-222222222222';
const AMB = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// A straight road north, one point every ~24.9 m, ~1.99 km long, with
// junctions at ~597 m, ~1194 m and ~1791 m - the same course the corridor
// tests use.
const LAT0 = 12.97;
const LNG = 77.59;
const STEP = 0.000225;
const at = (i) => [LAT0 + i * STEP, LNG];
const ROUTE = Array.from({ length: 81 }, (_, i) => at(i));
const SIGNALS = [24, 48, 72].map((i, n) => ({ osm_id: 1000 + n, lat: at(i)[0], lng: at(i)[1] }));

async function setup() {
  const db = await freshDb();
  await seedUsers(db, [
    { id: MEDIC, email: 'medic@x.com' },
    { id: DRIVER, email: 'driver@x.com' },
  ]);
  await db.query(
    `insert into public.vehicles (id, owner, vehicle_number, driver_name, vehicle_type, is_emergency_authorized)
     values ($1, $2, 'KA-01-AMB-0001', 'Medic', 'AMBULANCE', true)`,
    [AMB, MEDIC],
  );
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: MEDIC, role: 'authenticated' }),
  ]);
  return db;
}

const start = async (db) =>
  (
    await db.query(
      `select public.start_corridor($1, 'City Hospital', $2::jsonb, $3::jsonb, 1990, 180) as id`,
      [AMB, JSON.stringify(ROUTE), JSON.stringify(SIGNALS)],
    )
  ).rows[0].id;

/** The ambulance reports a position at route point `i`, heading north at 40. */
const drive = (db, i) =>
  db.query(
    `insert into public.vehicle_positions (vehicle_id, lat, lng, speed, heading)
     values ($1, $2, $3, 40, 0)
     on conflict (vehicle_id) do update
       set lat = excluded.lat, lng = excluded.lng, speed = excluded.speed,
           heading = excluded.heading, updated_at = now()`,
    [AMB, ...at(i)],
  );

const commands = async (db) =>
  (
    await db.query(
      `select command, osm_id, adapter, status, eta_s, approach_deg, vehicle_type
         from public.signal_commands order by id`,
    )
  ).rows;

test('approaching a junction asks for it to be pre-empted, with an arrival estimate', async () => {
  const db = await setup();
  await start(db);
  await drive(db, 0);
  await drive(db, 4); // ~100 m along: the first junction is ~500 m away

  const [c] = await commands(db);
  assert.equal(c.command, 'PREEMPT');
  assert.equal(Number(c.osm_id), 1000);
  assert.equal(c.vehicle_type, 'AMBULANCE');
  assert.equal(c.approach_deg, 0, 'coming from the south, heading north');
  // ~500 m at 40 km/h is ~45 s.
  assert.ok(c.eta_s >= 35 && c.eta_s <= 55, `eta ${c.eta_s}`);
});

test('then hold it green, then release it once passed', async () => {
  const db = await setup();
  await start(db);
  for (const i of [0, 4, 20, 30]) await drive(db, i);

  const forFirst = (await commands(db)).filter((c) => Number(c.osm_id) === 1000).map((c) => c.command);
  assert.deepEqual(forFirst, ['PREEMPT', 'HOLD_GREEN', 'RELEASE']);
});

// The rule that would matter most in a real city.
test('ending a corridor early releases every junction still held', async () => {
  const db = await setup();
  const id = await start(db);
  for (const i of [0, 4, 20]) await drive(db, i); // first junction now held green

  await db.query(`select public.end_corridor($1)`, [id]);

  const released = (await commands(db)).filter((c) => c.command === 'RELEASE').map((c) => Number(c.osm_id));
  assert.deepEqual(released, [1000]);
});

test('a junction never asked for is not released', async () => {
  const db = await setup();
  const id = await start(db);
  await drive(db, 0);
  await db.query(`select public.end_corridor($1)`, [id]);
  assert.deepEqual(await commands(db), []);
});

// Off by default: nothing leaves the system.
test('in simulation mode every command is recorded and none is sent', async () => {
  const db = await setup();
  await start(db);
  for (const i of [0, 4, 20, 30]) await drive(db, i);
  const all = await commands(db);
  assert.ok(all.length >= 3);
  assert.ok(all.every((c) => c.adapter === 'simulation' && c.status === 'SIMULATED'));
});

test('with an adapter switched on, commands queue for dispatch instead', async () => {
  const db = await setup();
  await db.query(`update public.settings set value = '"http"' where key = 'signal_adapter_mode'`);
  await start(db);
  await drive(db, 0);
  await drive(db, 4);
  const [c] = await commands(db);
  assert.equal(c.adapter, 'http');
  assert.equal(c.status, 'QUEUED');
});

describe_dispatch();
function describe_dispatch() {
  test('dispatch claims a queued command once, and records the city’s answer', async () => {
    const db = await setup();
    await db.query(`update public.settings set value = '"http"' where key = 'signal_adapter_mode'`);
    await start(db);
    await drive(db, 0);
    await drive(db, 4);
    const id = (await db.query(`select id from public.signal_commands limit 1`)).rows[0].id;

    assert.equal((await db.query(`select * from public.claim_signal_command($1)`, [id])).rows.length, 1);
    assert.equal((await db.query(`select * from public.claim_signal_command($1)`, [id])).rows.length, 0, 'claimed once');

    await db.query(`select public.record_signal_response($1, 'REJECTED', $2)`, [
      id,
      JSON.stringify({ reason: 'Junction under manual control' }),
    ]);
    const { rows } = await db.query(`select status, response from public.signal_commands where id = $1`, [id]);
    assert.equal(rows[0].status, 'REJECTED');
    assert.equal(rows[0].response.reason, 'Junction under manual control');
  });
}

test('the corridor’s driver can see what was asked; another driver cannot', async () => {
  const db = await setup();
  await start(db);
  for (const i of [0, 4]) await drive(db, i);
  await db.exec('commit; begin');

  await asUser(db, MEDIC, async () => {
    assert.equal((await db.query(`select count(*)::int as n from public.signal_commands`)).rows[0].n, 1);
  });
  await asUser(db, DRIVER, async () => {
    assert.equal((await db.query(`select count(*)::int as n from public.signal_commands`)).rows[0].n, 0);
  });
});

test('nothing here is callable by a client', async () => {
  const db = await setup();
  const { rows } = await db.query(`
    select has_function_privilege('authenticated', 'public.claim_signal_command(bigint)', 'execute') as claim,
           has_function_privilege('authenticated', 'public.record_signal_response(bigint, text, jsonb)', 'execute') as respond,
           has_function_privilege('service_role', 'public.claim_signal_command(bigint)', 'execute') as server`);
  assert.deepEqual(rows[0], { claim: false, respond: false, server: true });
});

// The gap this found: nothing used to end a corridor whose phone went silent.
describe_stale();
function describe_stale() {
  test('a corridor whose vehicle stops reporting is ended, and its junctions released', async () => {
    const db = await setup();
    const id = await start(db);
    for (const i of [0, 4, 20]) await drive(db, i); // first junction held green

    // Two and a half minutes of silence from the ambulance.
    await db.query(`update public.corridors set started_at = now() - interval '5 minutes' where id = $1`, [id]);
    await db.query(`update public.vehicle_positions set updated_at = now() - interval '150 seconds'`);

    const { rows } = await db.query(`select public.end_stale_corridors() as n`);
    assert.equal(rows[0].n, 1);
    const status = (await db.query(`select status from public.corridors where id = $1`, [id])).rows[0].status;
    assert.equal(status, 'ENDED');
    assert.ok((await commands(db)).some((c) => c.command === 'RELEASE' && Number(c.osm_id) === 1000));
  });

  test('a corridor past its hour is ended', async () => {
    const db = await setup();
    const id = await start(db);
    await drive(db, 0);
    await db.query(
      `update public.corridors set started_at = now() - interval '61 minutes', expires_at = now() - interval '1 minute' where id = $1`,
      [id],
    );
    assert.equal((await db.query(`select public.end_stale_corridors() as n`)).rows[0].n, 1);
  });

  test('a live corridor is left alone', async () => {
    const db = await setup();
    const id = await start(db);
    await db.query(`update public.corridors set started_at = now() - interval '5 minutes' where id = $1`, [id]);
    await drive(db, 0); // reporting now
    assert.equal((await db.query(`select public.end_stale_corridors() as n`)).rows[0].n, 0);
  });

  test('one opened a moment ago is not ended before its first position', async () => {
    const db = await setup();
    await start(db);
    assert.equal((await db.query(`select public.end_stale_corridors() as n`)).rows[0].n, 0);
  });
}
