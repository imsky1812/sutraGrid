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
    { id: DRIVER, email: 'a@x.com' },
    { id: OTHER, email: 'b@x.com' },
    { id: OPERATOR, email: 'ops@x.com' },
  ]);
  await db.query(
    `insert into public.vehicles (id, owner, vehicle_number, driver_name)
     values ($1,$2,'KA-03-AB-1234','A'), ($3,$4,'KA-03-CD-5678','B')`,
    [VEH_A, DRIVER, VEH_B, OTHER],
  );
  await db.query(`insert into public.operators (user_id) values ($1)`, [OPERATOR]);
  return db;
}

const send = (db, vehicleId, message, category = 'CONGESTION') =>
  db.query(
    `insert into public.alerts (created_by, vehicle_id, category, message)
     values ($1, $2, $3, $4)`,
    [OPERATOR, vehicleId, category, message],
  );

test('an operator can alert a single vehicle', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    await send(db, VEH_A, 'Congestion ahead on Airport Road');
    const { rows } = await db.query('select message from public.alerts');
    assert.equal(rows.length, 1);
  });
});

test('an operator can broadcast to the whole fleet', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    await send(db, null, 'Heavy rain citywide, reduce speed');
    await db.exec('commit; begin');
  });
  await asUser(db, DRIVER, async () => {
    const { rows } = await db.query('select message from public.alerts');
    assert.equal(rows.length, 1, 'a broadcast reaches every driver');
  });
});

// The core delivery rule: addressed alerts must not leak across drivers.
test('a driver does not see an alert addressed to another vehicle', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    await send(db, VEH_B, 'Slow down');
    await db.exec('commit; begin');
  });
  await asUser(db, DRIVER, async () => {
    const { rows } = await db.query('select message from public.alerts');
    assert.equal(rows.length, 0);
  });
});

test('a driver sees an alert addressed to their own vehicle', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    await send(db, VEH_A, 'Rule broken: speeding on MG Road', 'RULE');
    await db.exec('commit; begin');
  });
  await asUser(db, DRIVER, async () => {
    const { rows } = await db.query('select message, category from public.alerts');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].category, 'RULE');
  });
});

// Only operators direct traffic.
test('a driver cannot send an alert', async () => {
  const db = await setup();
  await asUser(db, DRIVER, async () => {
    await rejects(
      () =>
        db.query(
          `insert into public.alerts (created_by, vehicle_id, message)
           values ($1, $2, 'Everyone move')`,
          [DRIVER, VEH_B],
        ),
      { code: '42501' },
    );
  });
});

test('an operator cannot send an alert in another user name', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    await rejects(
      () =>
        db.query(
          `insert into public.alerts (created_by, vehicle_id, message)
           values ($1, $2, 'Spoofed')`,
          [DRIVER, VEH_A],
        ),
      { code: '42501' },
    );
  });
});

test('an empty alert message is rejected', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    await rejects(() => send(db, VEH_A, ''), { code: '23514' });
  });
});

test('an unknown category is rejected', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    await rejects(() => send(db, VEH_A, 'Test', 'NONSENSE'), { code: '23514' });
  });
});

test('a driver can acknowledge an alert for their own vehicle', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    await send(db, VEH_A, 'Congestion ahead');
    await db.exec('commit; begin');
  });
  const { rows } = await db.query('select id from public.alerts limit 1');
  await asUser(db, DRIVER, async () => {
    await db.query('insert into public.alert_receipts (alert_id, vehicle_id) values ($1,$2)', [
      rows[0].id,
      VEH_A,
    ]);
    const seen = await db.query('select alert_id from public.alert_receipts');
    assert.equal(seen.rows.length, 1);
  });
});

test('a driver cannot acknowledge for a vehicle they do not own', async () => {
  const db = await setup();
  await asUser(db, OPERATOR, async () => {
    await send(db, VEH_B, 'Slow down');
    await db.exec('commit; begin');
  });
  const { rows } = await db.query('select id from public.alerts limit 1');
  await asUser(db, DRIVER, async () => {
    await rejects(
      () =>
        db.query('insert into public.alert_receipts (alert_id, vehicle_id) values ($1,$2)', [
          rows[0].id,
          VEH_B,
        ]),
      { code: '42501' },
    );
  });
});
