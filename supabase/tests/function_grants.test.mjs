// Internal functions must not be callable through the REST API.
//
// Every function in the public schema is exposed at /rest/v1/rpc/<name>, and
// Postgres grants EXECUTE to PUBLIC by default. For a SECURITY DEFINER function
// that means any visitor runs it with the owner's rights.

import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedUsers, asUser, rejects } from './harness.mjs';

const USER = '11111111-1111-1111-1111-111111111111';

async function setup() {
  const db = await freshDb();
  await seedUsers(db, [{ id: USER, email: 'a@x.com' }]);
  return db;
}

const asAnon = async (db, fn) => {
  await db.exec('begin');
  try {
    await db.exec('set local role anon');
    return await fn();
  } finally {
    await db.exec('rollback');
  }
};

const INTERNAL = ['prune_old_data()', 'sync_operator_invites()'];

for (const call of INTERNAL) {
  test(`a signed-in user cannot call ${call}`, async () => {
    const db = await setup();
    await asUser(db, USER, () => rejects(() => db.query(`select public.${call}`), { code: '42501' }));
  });

  test(`an anonymous visitor cannot call ${call}`, async () => {
    const db = await setup();
    await asAnon(db, () => rejects(() => db.query(`select public.${call}`), { code: '42501' }));
  });
}

test('the corridor RPCs stay callable by signed-in users', async () => {
  const db = await setup();
  const { rows } = await db.query(
    `select has_function_privilege('authenticated', 'public.start_corridor(uuid, text, jsonb, jsonb, real, real)', 'execute') as start,
            has_function_privilege('authenticated', 'public.end_corridor(uuid)', 'execute') as stop`,
  );
  assert.deepEqual(rows[0], { start: true, stop: true });
});

// RLS policies call these as the requesting role, so revoking them would
// silently empty every protected table.
test('functions used inside RLS policies stay executable by signed-in users', async () => {
  const db = await setup();
  const { rows } = await db.query(
    `select has_function_privilege('authenticated', 'public.is_operator()', 'execute') as op,
            has_function_privilege('authenticated', 'public.can_see_corridor(uuid)', 'execute') as see`,
  );
  assert.deepEqual(rows[0], { op: true, see: true });
});

test('anonymous visitors cannot reach the corridor RPCs', async () => {
  const db = await setup();
  const { rows } = await db.query(
    `select has_function_privilege('anon', 'public.start_corridor(uuid, text, jsonb, jsonb, real, real)', 'execute') as start`,
  );
  assert.equal(rows[0].start, false);
});
