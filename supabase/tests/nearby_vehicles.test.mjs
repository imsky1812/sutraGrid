// What a driver may learn about the vehicles around them.
//
// Two rules carry this feature, and both are tested here rather than trusted:
// a driver may only ask as a vehicle they own, and what comes back carries no
// identity - no plate, no driver name, not even the vehicle id. Everything
// else (radius, staleness, ordering) exists so the radar draws something
// truthful.

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedUsers, asUser, rejects } from './harness.mjs';

const ME = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const MEDIC = '33333333-3333-3333-3333-333333333333';

const MINE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const THEIRS = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FAR = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const AMB = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const LAT = 28.6139;
const LNG = 77.209;
const M_PER_DEG_LAT = 110540;
/** `metres` north of where I am. */
const north = (metres) => LAT + metres / M_PER_DEG_LAT;

async function setup() {
  const db = await freshDb();
  await seedUsers(db, [
    { id: ME, email: 'me@x.com' },
    { id: OTHER, email: 'other@x.com' },
    { id: MEDIC, email: 'medic@x.com' },
  ]);
  await db.query(
    `insert into public.vehicles (id, owner, vehicle_number, driver_name, vehicle_type, is_emergency_authorized) values
       ($1, $2, 'DL 01 AA 0001', 'Me',    'NORMAL',    false),
       ($3, $4, 'DL 02 BB 0002', 'Other', 'NORMAL',    false),
       ($5, $4, 'DL 03 CC 0003', 'Other', 'NORMAL',    false),
       ($6, $7, 'DL 04 AMB 004', 'Medic', 'AMBULANCE', true)`,
    [MINE, ME, THEIRS, OTHER, FAR, AMB, MEDIC],
  );
  return db;
}

const place = (db, vehicleId, lat, lng, extra = {}) =>
  db.query(
    `insert into public.vehicle_positions (vehicle_id, lat, lng, speed, heading, updated_at)
     values ($1, $2, $3, $4, $5, now() - make_interval(secs => $6))
     on conflict (vehicle_id) do update
       set lat = excluded.lat, lng = excluded.lng, speed = excluded.speed,
           heading = excluded.heading, updated_at = excluded.updated_at`,
    [vehicleId, lat, lng, extra.speed ?? 0, extra.heading ?? 0, extra.ageSeconds ?? 0],
  );

const around = async (db, radius = null, vehicle = MINE) =>
  (
    await db.query(
      radius === null
        ? `select * from public.nearby_vehicles($1)`
        : `select * from public.nearby_vehicles($1, $2)`,
      radius === null ? [vehicle] : [vehicle, radius],
    )
  ).rows;

test('a driver sees a vehicle beside them', async () => {
  const db = await setup();
  await place(db, MINE, LAT, LNG);
  await place(db, THEIRS, north(80), LNG, { speed: 42, heading: 180 });

  await asUser(db, ME, async () => {
    const rows = await around(db);
    assert.equal(rows.length, 1);
    assert.equal(Math.round(rows[0].speed), 42);
    assert.equal(Math.round(rows[0].heading), 180);
    assert.equal(rows[0].vehicle_type, 'NORMAL');
    assert.equal(rows[0].is_emergency, false);
  });
});

// The reason this function exists instead of a Realtime subscription: nothing
// that identifies the other driver may cross the wire.
test('nothing identifying comes back', async () => {
  const db = await setup();
  await place(db, MINE, LAT, LNG);
  await place(db, THEIRS, north(80), LNG);

  await asUser(db, ME, async () => {
    const { fields, rows } = await db.query(`select * from public.nearby_vehicles($1)`, [MINE]);
    const names = fields.map((f) => f.name).sort();
    assert.deepEqual(names, [
      'heading',
      'is_emergency',
      'lat',
      'lng',
      'ref',
      'speed',
      'vehicle_type',
      'warned',
    ]);
    const serialized = JSON.stringify(rows);
    assert.ok(!serialized.includes(THEIRS), 'the vehicle id leaked');
    assert.ok(!serialized.includes('DL 02 BB 0002'), 'the plate leaked');
    assert.ok(!serialized.includes('Other'), 'the driver name leaked');
  });
});

test('the reference is stable for one caller and different for another', async () => {
  const db = await setup();
  await place(db, MINE, LAT, LNG);
  await place(db, THEIRS, north(80), LNG);
  await place(db, FAR, north(60), LNG);

  let mineSaw;
  await asUser(db, ME, async () => {
    mineSaw = (await around(db)).map((r) => r.ref);
    assert.deepEqual((await around(db)).map((r) => r.ref), mineSaw, 'not stable');
  });

  // The same neighbour, seen by someone else, must not carry the same handle,
  // or two drivers could compare notes and re-identify a vehicle.
  await asUser(db, OTHER, async () => {
    const theirs = (await around(db, null, THEIRS)).map((r) => r.ref);
    assert.ok(theirs.every((ref) => !mineSaw.includes(ref)));
  });
});

test('a vehicle outside the radius is not returned', async () => {
  const db = await setup();
  await place(db, MINE, LAT, LNG);
  await place(db, THEIRS, north(900), LNG);

  await asUser(db, ME, async () => {
    assert.equal((await around(db, 400)).length, 0);
    assert.equal((await around(db, 1000)).length, 1);
  });
});

test('the radius is clamped, so this cannot be used to watch the city', async () => {
  const db = await setup();
  await place(db, MINE, LAT, LNG);
  await place(db, THEIRS, north(5000), LNG);
  // Written as the owner: inside asUser the role is `authenticated`, and RLS
  // rightly refuses a position written for somebody else's vehicle.
  await place(db, FAR, north(10), LNG);

  await asUser(db, ME, async () => {
    // 5 km away, and asking for a 100 km radius does not reach it.
    assert.equal((await around(db, 100000)).map((r) => r.ref).length, 1);
    // A nonsensically small radius still returns the vehicle on top of you.
    assert.equal((await around(db, -5)).length, 1);
  });
});

// At 60 km/h a five-second-old position is already 80 m wrong. Drawing a ghost
// is worse than drawing nothing.
test('stale positions are left out', async () => {
  const db = await setup();
  await place(db, MINE, LAT, LNG);
  await place(db, THEIRS, north(80), LNG, { ageSeconds: 60 });

  await asUser(db, ME, () => around(db).then((rows) => assert.equal(rows.length, 0)));
});

test('the driver does not appear on their own radar', async () => {
  const db = await setup();
  await place(db, MINE, LAT, LNG);

  await asUser(db, ME, () => around(db).then((rows) => assert.equal(rows.length, 0)));
});

test('nearest first', async () => {
  const db = await setup();
  await place(db, MINE, LAT, LNG);
  await place(db, FAR, north(300), LNG);
  await place(db, THEIRS, north(60), LNG);
  await place(db, AMB, north(150), LNG);

  await asUser(db, ME, async () => {
    const types = (await around(db)).map((r) => r.vehicle_type);
    assert.deepEqual(types, ['NORMAL', 'AMBULANCE', 'NORMAL']);
  });
});

test('an emergency vehicle is marked as one', async () => {
  const db = await setup();
  await place(db, MINE, LAT, LNG);
  await place(db, AMB, north(100), LNG);

  await asUser(db, ME, async () => {
    const [row] = await around(db);
    assert.equal(row.is_emergency, true);
    assert.equal(row.vehicle_type, 'AMBULANCE');
  });
});

// So the radar can flash the vehicles that have been told to move over.
test('a vehicle warned by a live corridor is flagged', async () => {
  const db = await setup();
  await place(db, MINE, LAT, LNG);
  await place(db, THEIRS, north(80), LNG);
  await place(db, AMB, LAT, LNG);

  const corridor = (
    await db.query(
      `insert into public.corridors (vehicle_id, destination_lat, destination_lng, destination_name)
       values ($1, $2, $3, 'Hospital') returning id`,
      [AMB, north(2000), LNG],
    )
  ).rows[0].id;

  // The ambulance is also on the radar, so pick out the car it warns.
  const car = async () => (await around(db)).find((r) => r.vehicle_type === 'NORMAL');

  await asUser(db, ME, async () => assert.equal((await car()).warned, false));

  await db.query(
    `insert into public.corridor_warnings (corridor_id, vehicle_id) values ($1, $2)`,
    [corridor, THEIRS],
  );

  await asUser(db, ME, async () => assert.equal((await car()).warned, true));

  // An ended corridor is no longer a reason to flash anybody.
  await db.query(`update public.corridors set status = 'ENDED' where id = $1`, [corridor]);
  await asUser(db, ME, async () => assert.equal((await car()).warned, false));
});

test('a driver cannot ask as somebody else vehicle', async () => {
  const db = await setup();
  await place(db, MINE, LAT, LNG);
  await place(db, THEIRS, LAT, LNG);

  await asUser(db, ME, () => rejects(() => around(db, null, THEIRS), { code: '42501' }));
});

test('a vehicle that has never reported gets an empty answer, not an error', async () => {
  const db = await setup();
  await place(db, THEIRS, LAT, LNG);

  await asUser(db, ME, () => around(db).then((rows) => assert.equal(rows.length, 0)));
});

test('at most forty vehicles come back', async () => {
  const db = await setup();
  await place(db, MINE, LAT, LNG);

  // Fifty more vehicles, all within the radius.
  for (let i = 0; i < 50; i++) {
    const id = `eeeeeeee-eeee-eeee-eeee-${String(i).padStart(12, '0')}`;
    await db.query(
      `insert into public.vehicles (id, owner, vehicle_number, driver_name)
       values ($1, $2, $3, 'Crowd')`,
      [id, OTHER, `DL 99 ZZ ${String(1000 + i)}`],
    );
    await place(db, id, north(5 + i), LNG);
  }

  await asUser(db, ME, () => around(db).then((rows) => assert.equal(rows.length, 40)));
});

test('anonymous visitors cannot reach it', async () => {
  const db = await setup();
  const { rows } = await db.query(
    `select has_function_privilege('anon', 'public.nearby_vehicles(uuid, real)', 'execute') as anon,
            has_function_privilege('authenticated', 'public.nearby_vehicles(uuid, real)', 'execute') as auth`,
  );
  assert.deepEqual(rows[0], { anon: false, auth: true });
});
