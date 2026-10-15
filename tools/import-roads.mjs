#!/usr/bin/env node
/**
 * Load OpenStreetMap roads for an area into road_segments, so the database
 * can tell when a vehicle is going the wrong way down a one-way road (and,
 * later, what the speed limit is on each road).
 *
 * Runs from a laptop rather than a server on purpose: the public Overpass
 * servers refuse requests from Supabase's Edge runtime (measured: 406 and 500
 * where an ordinary network gets 200). Signs in as an operator, because only
 * operators may load road data.
 *
 *   node tools/import-roads.mjs --near 28.6241,77.4356 --radius 3000
 *   node tools/import-roads.mjs --bbox 28.60,77.40,28.65,77.47
 *   node tools/import-roads.mjs --near 28.6241,77.4356 --dry-run
 *
 * Without --near or --bbox it centres on the account's most recent vehicle
 * position. Credentials: SUTRA_EMAIL and SUTRA_PASSWORD (an operator account).
 * Re-running for the same area replaces those roads rather than duplicating.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import './env.mjs';
import { createClient } from '@supabase/supabase-js';
import { batches, bboxAround, overpassQuery, segmentsFromWays, tiles, uniqueWays } from './roads.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Public instances listed on the OpenStreetMap wiki. Any one of them can be
// down or rate-limiting at a given moment (on 16 October overpass-api.de
// returned 502 for its own status page while the mail.ru mirror answered), so
// each request walks the list.
const OVERPASS = (
  process.env.OVERPASS_URLS ??
  [
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ].join(',')
)
  .split(',')
  .map((u) => u.trim());

const argOf = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

function config() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY };
  }
  const file = readFileSync(join(ROOT, 'admin-dashboard', 'config.js'), 'utf8');
  return {
    url: /SUPABASE_URL:\s*'([^']+)'/.exec(file)?.[1],
    key: /SUPABASE_ANON_KEY:\s*'([^']+)'/.exec(file)?.[1],
  };
}

/** One tile, from whichever server will answer. Null if none would. */
async function fetchTile(bbox) {
  const body = `data=${encodeURIComponent(overpassQuery(bbox))}`;
  for (const url of OVERPASS) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // overpass-api.de answers 406 without both of these.
          Accept: 'application/json',
          'User-Agent': 'SUTRA-traffic/1.0 (road import)',
        },
        body,
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        console.warn(`  ${new URL(url).host}: ${response.status}`);
        continue;
      }
      return (await response.json()).elements ?? [];
    } catch (e) {
      console.warn(`  ${new URL(url).host}: ${e.message}`);
    }
  }
  return null;
}

/** A tile from whichever server answers, retrying after a pause if none will. */
async function fetchTileWithRetry(bbox, index, total) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      console.warn(`  every server refused tile ${index}/${total}; trying again in ${attempt * 20}s`);
      await pause(attempt * 20_000);
    }
    const elements = await fetchTile(bbox);
    if (elements !== null) return elements;
  }
  return null;
}

/** Replace these roads: clear any earlier copy of each way, then insert. */
async function writeSegments(supabase, rows) {
  const wayIds = [...new Set(rows.map((r) => r.osm_way_id))];
  for (const ids of batches(wayIds, 300)) {
    const { error } = await supabase.from('road_segments').delete().in('osm_way_id', ids);
    if (error) throw new Error(`Could not clear old segments: ${error.message}`);
  }
  for (const batch of batches(rows, 500)) {
    const { error } = await supabase.from('road_segments').insert(batch);
    if (error) throw new Error(`Insert failed: ${error.message}`);
  }
}

async function main() {
  const radius = Math.min(Math.max(Number(argOf('radius', 2500)), 200), 10_000);
  const dryRun = hasFlag('dry-run');
  let supabase = null;

  if (!dryRun) {
    const { url, key } = config();
    if (!process.env.SUTRA_EMAIL || !process.env.SUTRA_PASSWORD) {
      throw new Error('Set SUTRA_EMAIL and SUTRA_PASSWORD to an operator account, or pass --dry-run.');
    }
    supabase = createClient(url, key, { auth: { persistSession: false } });
    const { error } = await supabase.auth.signInWithPassword({
      email: process.env.SUTRA_EMAIL,
      password: process.env.SUTRA_PASSWORD,
    });
    if (error) throw new Error(`Sign-in failed: ${error.message}`);
  }

  let bbox;
  if (argOf('bbox')) {
    bbox = argOf('bbox').split(',').map(Number);
  } else if (argOf('near')) {
    const [lat, lng] = argOf('near').split(',').map(Number);
    bbox = bboxAround(lat, lng, radius);
  } else if (supabase) {
    const { data } = await supabase
      .from('vehicle_positions')
      .select('lat, lng')
      .order('updated_at', { ascending: false })
      .limit(1);
    if (!data?.length) throw new Error('No vehicle position to centre on. Pass --near lat,lng.');
    bbox = bboxAround(data[0].lat, data[0].lng, radius);
  } else {
    throw new Error('A dry run needs --near lat,lng or --bbox.');
  }

  if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) {
    throw new Error('Box must be south,west,north,east.');
  }
  const parts = tiles(bbox);
  console.log(`Fetching roads in ${bbox.join(', ')} as ${parts.length} tile(s)…`);

  // Each tile is written as it arrives. If the servers give out part-way, what
  // was loaded stays loaded, and running the same command again finishes it:
  // every road replaces its own earlier copy, so repeats are harmless.
  const seen = new Set();
  let roads = 0;
  let segments = 0;
  let oneway = 0;
  let limits = 0;

  for (let i = 0; i < parts.length; i++) {
    // A pause between requests keeps a public server from rate-limiting us.
    if (i > 0) await pause(3_000);
    const elements = await fetchTileWithRetry(parts[i], i + 1, parts.length);
    if (elements === null) {
      throw new Error(
        `Every Overpass server refused tile ${i + 1} of ${parts.length}. ` +
          (dryRun ? 'Try again later.' : `Tiles 1-${i} are saved; run the same command again to finish.`),
      );
    }

    // A road crossing a tile edge comes back whole from both; count it once.
    const fresh = uniqueWays(elements).filter((w) => !seen.has(w.id));
    fresh.forEach((w) => seen.add(w.id));
    const rows = segmentsFromWays(fresh);
    roads += fresh.length;
    segments += rows.length;
    oneway += rows.filter((r) => r.oneway).length;
    limits += rows.filter((r) => r.maxspeed_kmh).length;

    if (!dryRun && rows.length > 0) await writeSegments(supabase, rows);
    console.log(`  tile ${i + 1}/${parts.length}: ${fresh.length} roads, ${rows.length} segments${dryRun ? '' : ' written'}`);
  }

  console.log(
    `${roads} roads, ${segments} segments: ${oneway} one-way, ${limits} with a posted speed limit.`,
  );
  console.log(dryRun ? 'Dry run: nothing written.' : 'Done. Wrong-way checks now cover this area.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
