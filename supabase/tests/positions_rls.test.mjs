import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedUsers, asUser, rejects } from './harness.mjs';

const DRIVER_A = '11111111-1111-1111-1111-111111111111';
const DRIVER_B = '22222222-2222-2222-2222-222222222222';
const VEHICLE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VEHICLE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function setup() {
  const db = await freshDb();
  await seedUsers(db, [
    { id: DRIVER_A, email: 'driver.a@example.com' },
    { id: DRIVER_B, email: 'driver.b@example.com' },
  ]);
  // Seeded as owner so the fixture does not depend on the insert policy.
  await db.query(
    `insert into public.vehicles (id, owner, vehicle_number, driver_name)
     values ($1, $2, 'KA-03-AB-1234', 'Driver A'), ($3, $4, 'KA-03-CD-5678', 'Driver B')`,
    [VEHICLE_A, DRIVER_A, VEHICLE_B, DRIVER_B],
  );
  return db;
}

const position = (vehicleId, overrides = {}) => ({
  vehicle_id: vehicleId,
  lat: 12.9716,
  lng: 77.5946,
  speed: 42.5,
  heading: 90,
  ...overrides,
});

async function insertPosition(db, p) {
  return db.query(
    `insert into public.vehicle_positions (vehicle_id, lat, lng, speed, heading)
     values ($1, $2, $3, $4, $5)`,
    [p.vehicle_id, p.lat, p.lng, p.speed, p.heading],
  );
}

test('a driver can write a position for their own vehicle', async () => {
  const db = await setup();
  await asUser(db, DRIVER_A, async () => {
    await insertPosition(db, position(VEHICLE_A));
    const { rows } = await db.query(
      `select speed from public.vehicle_positions where vehicle_id = $1`,
      [VEHICLE_A],
    );
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].speed), 42.5);
  });
});

test('a driver cannot write a position for another vehicle', async () => {
  const db = await setup();
  await asUser(db, DRIVER_A, async () => {
    await rejects(() => insertPosition(db, position(VEHICLE_B)), { code: '42501' });
  });
});

test('a driver cannot read another vehicle position', async () => {
  const db = await setup();
  await db.query(
    `insert into public.vehicle_positions (vehicle_id, lat, lng, speed, heading)
     values ($1, 12.9, 77.6, 30, 45)`,
    [VEHICLE_B],
  );
  await asUser(db, DRIVER_A, async () => {
    const { rows } = await db.query(`select vehicle_id from public.vehicle_positions`);
    assert.equal(rows.length, 0);
  });
});

test('an out-of-range latitude is rejected', async () => {
  const db = await setup();
  await asUser(db, DRIVER_A, async () => {
    await rejects(() => insertPosition(db, position(VEHICLE_A, { lat: 999 })), { code: '23514' });
  });
});

test('an out-of-range longitude is rejected', async () => {
  const db = await setup();
  await asUser(db, DRIVER_A, async () => {
    await rejects(() => insertPosition(db, position(VEHICLE_A, { lng: -181 })), { code: '23514' });
  });
});

test('a negative speed is rejected', async () => {
  const db = await setup();
  await asUser(db, DRIVER_A, async () => {
    await rejects(() => insertPosition(db, position(VEHICLE_A, { speed: -1 })), { code: '23514' });
  });
});

test('an implausible speed is rejected', async () => {
  const db = await setup();
  await asUser(db, DRIVER_A, async () => {
    await rejects(() => insertPosition(db, position(VEHICLE_A, { speed: 501 })), { code: '23514' });
  });
});

// Range checks live in the database precisely so a modified client cannot get
// past them. The Node relay validated in application code, which meant one
// malformed frame could poison shared state.
test('a heading outside 0-360 is rejected', async () => {
  const db = await setup();
  await asUser(db, DRIVER_A, async () => {
    await rejects(() => insertPosition(db, position(VEHICLE_A, { heading: 400 })), { code: '23514' });
  });
});

test('upserting the same vehicle replaces its position rather than accumulating', async () => {
  const db = await setup();
  await asUser(db, DRIVER_A, async () => {
    await insertPosition(db, position(VEHICLE_A));
    await db.query(
      `insert into public.vehicle_positions (vehicle_id, lat, lng, speed, heading)
       values ($1, 13.0, 77.7, 55, 180)
       on conflict (vehicle_id) do update set
         lat = excluded.lat, lng = excluded.lng,
         speed = excluded.speed, heading = excluded.heading`,
      [VEHICLE_A],
    );
    const { rows } = await db.query(
      `select count(*)::int as n, max(speed) as speed from public.vehicle_positions where vehicle_id = $1`,
      [VEHICLE_A],
    );
    assert.equal(rows[0].n, 1);
    assert.equal(Number(rows[0].speed), 55);
  });
});

// If this ever fails, someone has added a column the client could lie about.
test('vehicle_positions carries no emergency column for a client to assert', async () => {
  const db = await freshDb();
  const { rows } = await db.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'vehicle_positions'
       and column_name ilike '%emergency%'`,
  );
  assert.equal(rows.length, 0, `unexpected column(s): ${rows.map((r) => r.column_name).join(', ')}`);
});

test('emergency status is derivable by joining to vehicles', async () => {
  const db = await setup();
  await db.query(
    `update public.vehicles set is_emergency_authorized = true where id = $1`,
    [VEHICLE_A],
  );
  await db.query(
    `insert into public.vehicle_positions (vehicle_id, lat, lng, speed, heading)
     values ($1, 12.9716, 77.5946, 42.5, 90)`,
    [VEHICLE_A],
  );
  const { rows } = await db.query(
    `select v.is_emergency_authorized
     from public.vehicle_positions p
     join public.vehicles v on v.id = p.vehicle_id
     where p.vehicle_id = $1`,
    [VEHICLE_A],
  );
  assert.equal(rows[0].is_emergency_authorized, true);
});
