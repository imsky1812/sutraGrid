// Push notifications: which phone gets which alert, and who may decide.
//
// The rules that matter: a driver can only point their phone at a vehicle they
// own; an alert addressed to one vehicle reaches the phone in it and no other;
// an alert is pushed at most once however many times delivery is requested;
// and nothing a phone can call is able to mark alerts delivered or unregister
// someone else's device.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedUsers, asUser, rejects } from './harness.mjs';

const ME = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const OPS = '33333333-3333-3333-3333-333333333333';

const CAR = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VAN = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const THEIRS = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const token = (n) => `ExponentPushToken[device${String(n).padStart(12, '0')}]`;

async function setup() {
  const db = await freshDb();
  await seedUsers(db, [
    { id: ME, email: 'me@x.com' },
    { id: OTHER, email: 'other@x.com' },
    { id: OPS, email: 'ops@x.com' },
  ]);
  await db.query(
    `insert into public.vehicles (id, owner, vehicle_number, driver_name) values
       ($1, $2, 'DL 01 AA 0001', 'Me'),
       ($3, $2, 'DL 01 AA 0002', 'Me'),
       ($4, $5, 'DL 02 BB 0003', 'Other')`,
    [CAR, ME, VAN, THEIRS, OTHER],
  );
  await db.query(`insert into public.operators (user_id) values ($1)`, [OPS]);
  return db;
}

const register = (db, tok, vehicle, platform = 'android') =>
  db.query(`select public.register_push_token($1, $2, $3)`, [tok, vehicle, platform]);

const devices = async (db) =>
  (await db.query(`select token, user_id, vehicle_id from public.device_tokens order by token`)).rows;

const alert = async (db, { vehicle = null, expiresIn = '10 minutes', severity = 'WARNING' } = {}) =>
  (
    await db.query(
      `insert into public.alerts (created_by, vehicle_id, category, severity, message, expires_at)
       values ($1, $2, 'MESSAGE', $3, 'Test alert', now() + $4::interval) returning id`,
      [OPS, vehicle, severity, expiresIn],
    )
  ).rows[0].id;

const claim = async (db, id) =>
  (await db.query(`select * from public.claim_alert_push($1)`, [id])).rows;

describe('registering a phone', () => {
  test('a driver registers their phone to a vehicle they own', async () => {
    const db = await setup();
    await asUser(db, ME, async () => {
      await register(db, token(1), CAR);
      await db.exec('commit; begin');
    });
    assert.deepEqual(await devices(db), [{ token: token(1), user_id: ME, vehicle_id: CAR }]);
  });

  test('not to a vehicle somebody else owns', async () => {
    const db = await setup();
    await asUser(db, ME, () => rejects(() => register(db, token(1), THEIRS), { code: '42501' }));
    assert.equal((await devices(db)).length, 0);
  });

  test('something that is not an Expo token is refused', async () => {
    const db = await setup();
    for (const bad of ['', 'hello', 'ExponentPushToken[]', 'ExponentPushToken[a b c d e f g h i]']) {
      await asUser(db, ME, () => rejects(() => register(db, bad, CAR), { code: '22023' }));
    }
  });

  test('an unknown platform is refused', async () => {
    const db = await setup();
    await asUser(db, ME, () => rejects(() => register(db, token(1), CAR, 'blackberry'), { code: '22023' }));
  });

  // Starting a shift in a different vehicle must move the phone with it, or
  // alerts for the van would keep going to the car's driver.
  test('switching vehicle moves the phone, it does not duplicate it', async () => {
    const db = await setup();
    await asUser(db, ME, async () => {
      await register(db, token(1), CAR);
      await register(db, token(1), VAN);
      await db.exec('commit; begin');
    });
    assert.deepEqual(await devices(db), [{ token: token(1), user_id: ME, vehicle_id: VAN }]);
  });

  // Holding the token proves the device. A phone that signs in as someone
  // else must stop receiving the previous person's alerts.
  test('a phone that signs in as someone else goes with them', async () => {
    const db = await setup();
    await asUser(db, ME, async () => {
      await register(db, token(1), CAR);
      await db.exec('commit; begin');
    });
    await asUser(db, OTHER, async () => {
      await register(db, token(1), THEIRS);
      await db.exec('commit; begin');
    });
    assert.deepEqual(await devices(db), [{ token: token(1), user_id: OTHER, vehicle_id: THEIRS }]);
  });

  test('a driver sees and removes only their own devices', async () => {
    const db = await setup();
    await asUser(db, ME, async () => {
      await register(db, token(1), CAR);
      await db.exec('commit; begin');
    });
    await asUser(db, OTHER, async () => {
      await register(db, token(2), THEIRS);
      await db.exec('commit; begin');
    });

    await asUser(db, ME, async () => {
      const seen = (await db.query(`select token from public.device_tokens`)).rows;
      assert.deepEqual(seen, [{ token: token(1) }]);
      // Deleting someone else's row silently matches nothing.
      await db.query(`delete from public.device_tokens where token = $1`, [token(2)]);
      await db.exec('commit; begin');
    });
    assert.equal((await devices(db)).length, 2);
  });

  test('a phone cannot write a token row directly', async () => {
    const db = await setup();
    await asUser(db, ME, () =>
      rejects(() =>
        db.query(`insert into public.device_tokens (token, user_id, vehicle_id) values ($1, $2, $3)`, [
          token(1),
          ME,
          CAR,
        ]),
      ),
    );
  });
});

describe('claiming an alert', () => {
  const twoPhones = async (db) => {
    await asUser(db, ME, async () => {
      await register(db, token(1), CAR);
      await register(db, token(2), VAN);
      await db.exec('commit; begin');
    });
    await asUser(db, OTHER, async () => {
      await register(db, token(3), THEIRS);
      await db.exec('commit; begin');
    });
  };

  // The point of tying a device to a vehicle: the same owner's other phone,
  // in another vehicle, is not told to give way.
  test('an addressed alert goes only to the phone in that vehicle', async () => {
    const db = await setup();
    await twoPhones(db);
    const [row] = await claim(db, await alert(db, { vehicle: CAR }));
    assert.deepEqual(row.tokens, [token(1)]);
  });

  test('a broadcast goes to every registered phone', async () => {
    const db = await setup();
    await twoPhones(db);
    const [row] = await claim(db, await alert(db));
    assert.deepEqual([...row.tokens].sort(), [token(1), token(2), token(3)]);
  });

  test('it carries what the notification needs', async () => {
    const db = await setup();
    await twoPhones(db);
    const id = await alert(db, { vehicle: CAR, severity: 'CRITICAL' });
    const [row] = await claim(db, id);
    assert.equal(Number(row.alert_id), Number(id));
    assert.equal(row.category, 'MESSAGE');
    assert.equal(row.severity, 'CRITICAL');
    assert.equal(row.message, 'Test alert');
    assert.ok(row.expires_at instanceof Date);
  });

  // pg_net delivers at least once, and anyone holding the public key can call
  // the function. Neither may produce a second notification.
  test('an alert is pushed at most once', async () => {
    const db = await setup();
    await twoPhones(db);
    const id = await alert(db, { vehicle: CAR });
    assert.equal((await claim(db, id)).length, 1);
    assert.equal((await claim(db, id)).length, 0);
  });

  test('an expired alert is claimed but goes nowhere', async () => {
    const db = await setup();
    await twoPhones(db);
    const id = await alert(db, { vehicle: CAR, expiresIn: '-1 minute' });
    const [row] = await claim(db, id);
    assert.deepEqual(row.tokens, []);
    // And it is not offered again later.
    assert.equal((await claim(db, id)).length, 0);
  });

  test('an unknown alert returns nothing', async () => {
    const db = await setup();
    assert.equal((await claim(db, 999999)).length, 0);
  });

  test('an alert to a vehicle with no phone goes nowhere, without error', async () => {
    const db = await setup();
    const [row] = await claim(db, await alert(db, { vehicle: CAR }));
    assert.deepEqual(row.tokens, []);
  });

  test('uninstalled devices can be forgotten', async () => {
    const db = await setup();
    await twoPhones(db);
    const { rows } = await db.query(`select public.forget_push_tokens($1) as n`, [[token(1), token(3)]]);
    assert.equal(rows[0].n, 2);
    assert.deepEqual((await devices(db)).map((d) => d.token), [token(2)]);
  });
});

// Without pg_net (as here, in plain Postgres) the trigger must stand aside.
// An alert that fails to save because its push could not be requested would
// be the worst possible outcome of adding push.
test('saving an alert never depends on push being available', async () => {
  const db = await setup();
  const id = await alert(db, { vehicle: CAR });
  const { rows } = await db.query(`select pushed_at from public.alerts where id = $1`, [id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pushed_at, null);
});

test('only the server can claim alerts or forget devices', async () => {
  const db = await setup();
  const { rows } = await db.query(`
    select
      has_function_privilege('authenticated', 'public.claim_alert_push(bigint)', 'execute') as claim_auth,
      has_function_privilege('anon', 'public.claim_alert_push(bigint)', 'execute') as claim_anon,
      has_function_privilege('service_role', 'public.claim_alert_push(bigint)', 'execute') as claim_service,
      has_function_privilege('authenticated', 'public.forget_push_tokens(text[])', 'execute') as forget_auth,
      has_function_privilege('service_role', 'public.forget_push_tokens(text[])', 'execute') as forget_service,
      has_function_privilege('anon', 'public.register_push_token(text, uuid, text)', 'execute') as register_anon,
      has_function_privilege('authenticated', 'public.register_push_token(text, uuid, text)', 'execute') as register_auth,
      has_function_privilege('authenticated', 'public.request_alert_push()', 'execute') as trigger_auth
  `);
  assert.deepEqual(rows[0], {
    claim_auth: false,
    claim_anon: false,
    claim_service: true,
    forget_auth: false,
    forget_service: true,
    register_anon: false,
    register_auth: true,
    trigger_auth: false,
  });
});

test('a signed-in driver cannot mark an alert as delivered', async () => {
  const db = await setup();
  const id = await alert(db, { vehicle: CAR });
  await asUser(db, ME, () => rejects(() => claim(db, id), { code: '42501' }));
});
