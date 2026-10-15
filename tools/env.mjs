/**
 * Read tools/.env into process.env, without overriding anything already set.
 *
 * The tools sign in as a real account, so they need a password. Keeping it in
 * a local file means it is typed once, into an editor, and never into a chat,
 * a shell history or the repository: tools/.env is git-ignored.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '.env');

export function loadEnv(file = FILE) {
  if (!existsSync(file)) return false;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}

loadEnv();
