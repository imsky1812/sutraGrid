#!/usr/bin/env node
/**
 * A simulated fleet, so the system can be demonstrated without a phone per
 * vehicle.
 *
 * It is deliberately not a shortcut: every vehicle signs in as a real account,
 * registers a real vehicle and upserts into vehicle_positions through the same
 * client the app uses. So the triggers run, history and violations are written,
 * green-corridor warnings fire, and the surroundings view sees it - because
 * none of them can tell the difference. Nothing here bypasses row-level
 * security; if a rule would stop a driver, it stops the simulator too.
 *
 *   node tools/simulate.mjs --count 5
 *   node tools/simulate.mjs --near 28.6139,77.2090 --count 8 --speeder
 *   node tools/simulate.mjs --cleanup
 *
 * Credentials come from the environment:
 *   SUTRA_EMAIL, SUTRA_PASSWORD   the account the simulated vehicles belong to
 *   SUPABASE_URL, SUPABASE_ANON_KEY  (optional; read from the dashboard config)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { createDriver, pickDestination, plateFor, SIM_PLATE_PREFIX } from './simulator.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTER = process.env.ROUTER_URL ?? 'https://router.project-osrm.org';
const TICK_MS = 2000;
const DEFAULT_RADIUS_M = 1200;

function argOf(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

/** The dashboard already holds these locally, so no second place to configure. */
function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (url && key) return { url, key };

  try {
    const file = readFileSync(join(ROOT, 'admin-dashboard', 'config.js'), 'utf8');
    return {
      url: url ?? /SUPABASE_URL:\s*'([^']+)'/.exec(file)?.[1],
      key: key ?? /SUPABASE_ANON_KEY:\s*'([^']+)'/.exec(file)?.[1],
    };
  } catch {
    return { url, key };
  }
}

async function routeBetween(from, to) {
  const url =
    `${ROUTER}/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}` +
    `?overview=full&geometries=geojson&alternatives=false&steps=false`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Routing failed: ${response.status}`);

  const data = await response.json();
  const coordinates = data?.routes?.[0]?.geometry?.coordinates;
  if (data?.code !== 'Ok' || !coordinates || coordinates.length < 2) {
    throw new Error(`Routing failed: ${data?.code ?? 'NoRoute'}`);
  }
  return coordinates.map(([lng, lat]) => [lat, lng]);
}

async function main() {
  const { url, key } = config();
  const email = process.env.SUTRA_EMAIL;
  const password = process.env.SUTRA_PASSWORD;

  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_ANON_KEY, or create admin-dashboard/config.js.');
  if (!email || !password) throw new Error('Set SUTRA_EMAIL and SUTRA_PASSWORD to the account the simulated vehicles belong to.');

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
  if (authError) throw new Error(`Sign-in failed: ${authError.message}`);

  // Leftovers from an interrupted run, or an explicit clean-up.
  const { data: existing } = await supabase
    .from('vehicles')
    .select('id, vehicle_number')
    .like('vehicle_number', `${SIM_PLATE_PREFIX}%`);

  if (existing?.length) {
    await supabase.from('vehicles').delete().in('id', existing.map((v) => v.id));
    console.log(`Removed ${existing.length} vehicle(s) from a previous run.`);
  }
  if (hasFlag('cleanup')) return;

  const count = Math.min(Math.max(Number(argOf('count', 4)), 1), 20);
  const radiusM = Number(argOf('radius', DEFAULT_RADIUS_M));
  const targetKmh = Number(argOf('speed', 38));

  // Default to wherever the account's own vehicle last reported, so the
  // simulated traffic appears around the real phone rather than in another city.
  let centre;
  const near = argOf('near');
  if (near) {
    centre = near.split(',').map(Number);
  } else {
    const { data: mine } = await supabase
      .from('vehicle_positions')
      .select('lat, lng, updated_at')
      .order('updated_at', { ascending: false })
      .limit(1);
    if (!mine?.length) throw new Error('No position to centre on yet. Start a shift on a phone, or pass --near lat,lng.');
    centre = [mine[0].lat, mine[0].lng];
  }
  console.log(`Centring ${count} vehicle(s) on ${centre[0].toFixed(5)}, ${centre[1].toFixed(5)}.`);

  const speedLimit = (
    await supabase.from('settings').select('value').eq('key', 'speed_limit_kmh').single()
  ).data?.value ?? 80;

  const drivers = [];
  for (let i = 0; i < count; i++) {
    const plate = plateFor(i);
    // One of them can be made to speed, which is the quickest way to show an
    // automatic violation alert arriving on a real phone.
    const speeding = hasFlag('speeder') && i === 0;
    const { data: vehicle, error } = await supabase
      .from('vehicles')
      .insert({
        owner: (await supabase.auth.getUser()).data.user.id,
        vehicle_number: plate,
        driver_name: speeding ? 'Simulated (speeding)' : 'Simulated',
        vehicle_type: 'NORMAL',
      })
      .select('id')
      .single();
    if (error) throw new Error(`Could not register ${plate}: ${error.message}`);

    drivers.push(
      createDriver({
        id: vehicle.id,
        plate,
        targetKmh: speeding ? Number(speedLimit) + 25 : targetKmh,
      }),
    );
    console.log(`  ${plate}${speeding ? '  (will exceed the limit)' : ''}`);
  }

  let stopping = false;
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\nRemoving simulated vehicles…');
    await supabase.from('vehicles').delete().in('id', drivers.map((d) => d.id));
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  console.log('Running. Press Ctrl-C to stop and remove them.\n');

  const tick = async () => {
    if (stopping) return;

    for (const driver of drivers) {
      try {
        if (driver.needsRoute) {
          const from = driver.last ?? pickDestination(centre, radiusM);
          driver.setRoute(await routeBetween(from, pickDestination(centre, radiusM)));
        }

        const frame = driver.advance(TICK_MS / 1000);
        if (!frame) continue;
        driver.last = [frame.lat, frame.lng];

        const { error } = await supabase.from('vehicle_positions').upsert(
          {
            vehicle_id: driver.id,
            lat: frame.lat,
            lng: frame.lng,
            speed: frame.speed,
            heading: frame.heading,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'vehicle_id' },
        );
        if (error) console.warn(`${driver.plate}: ${error.message}`);
      } catch (e) {
        // One vehicle failing to route must not take the fleet down.
        console.warn(`${driver.plate}: ${e.message}`);
      }
    }
  };

  await tick();
  setInterval(tick, TICK_MS);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
