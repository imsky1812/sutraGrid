// Test harness: boots an in-process Postgres (PGlite), recreates the parts of
// Supabase the migrations depend on, then applies the real migration files.
//
// The migrations here are byte-identical to the ones pushed to the hosted
// project. What is simulated is the surrounding Supabase runtime: the `auth`
// schema, the built-in roles, and the default privileges Supabase grants. That
// means these tests verify policy *logic*, not Supabase's own auth
// implementation. Confirmation against the real project happens on `db push`.

import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');

/**
 * Mirrors the roles, auth schema and default privileges a Supabase project
 * starts with. Without this the migrations would be testing against a bare
 * Postgres that looks nothing like production.
 */
const BOOTSTRAP = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;

  create table auth.users (
    id    uuid primary key,
    email text unique
  );

  -- Supabase reads the caller's identity out of the request JWT claims.
  create function auth.uid() returns uuid
    language sql stable
  as $$
    select nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;

  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant select on auth.users to authenticated, service_role;

  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on tables to anon, authenticated, service_role;
`;

/**
 * Boot a database with all migrations applied, in filename order.
 *
 * Each test gets its own instance. Snapshotting the migrated state via
 * dumpDataDir/loadDataDir was tried to avoid replaying migrations per test and
 * was slower, not faster, so this stays deliberately simple.
 */
export async function freshDb() {
  const db = new PGlite();
  await db.exec(BOOTSTRAP);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);

  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await db.exec(sql);
    } catch (e) {
      throw new Error(`Migration ${file} failed: ${e.message}`);
    }
  }

  return db;
}

/** Insert auth users directly; there is no signup flow involved in these tests. */
export async function seedUsers(db, users) {
  for (const { id, email } of users) {
    await db.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
  }
}

/**
 * Run `fn` as an authenticated user, inside a transaction that is always rolled
 * back so tests cannot leak state into each other.
 *
 * `set local role` is what actually engages RLS: the bootstrap owner bypasses
 * it, so a test that forgets this would pass while proving nothing.
 */
export async function asUser(db, userId, fn) {
  await db.exec('begin');
  try {
    await db.exec(`set local role authenticated;`);
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    return await fn();
  } finally {
    await db.exec('rollback');
  }
}

/** Assert that `fn` rejects, optionally with a specific SQLSTATE. */
export async function rejects(fn, { code, message } = {}) {
  let error = null;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  if (!error) throw new Error('Expected the statement to be rejected, but it succeeded.');
  if (code && error.code !== code) {
    throw new Error(`Expected SQLSTATE ${code}, got ${error.code}: ${error.message}`);
  }
  if (message && !error.message.includes(message)) {
    throw new Error(`Expected message containing "${message}", got: ${error.message}`);
  }
  return error;
}
