import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import type { PositionRow } from './telemetry';

/**
 * Positions recorded while the phone had no signal, sent once it is back.
 *
 * They go to the server as history only (record_buffered_positions), never
 * as the vehicle's live position: replaying ten minutes of old fixes as live
 * ones would move the vehicle backwards on every map and run every safety
 * check on stale data. The track is completed; nothing live is disturbed.
 *
 * Kept in AsyncStorage, so an outage survives the app being closed or the
 * phone restarting.
 */

/** At one fix every 3 s, 25 minutes; at 1 s, about 8. Oldest dropped beyond. */
export const MAX_BUFFERED = 500;
/** Per request. The server takes at most 500. */
export const BATCH = 200;
/** After a reconnect, do not send more often than this. */
export const FLUSH_INTERVAL_MS = 15_000;

type Buffered = Pick<PositionRow, 'lat' | 'lng' | 'speed' | 'heading'> & { recorded_at: string };

const keyFor = (vehicleId: string) => `sutra.offline.${vehicleId}`;

/**
 * Whether a refused upsert is worth keeping for later.
 *
 * A network failure has no database code. A refusal for the data itself -
 * a constraint (SQLSTATE class 22 or 23) or a permission check (42) - would
 * be refused again later, so keeping it only fills the buffer.
 */
export function shouldBuffer(
  error: { code?: string | null; message?: string } | null | undefined,
): boolean {
  if (!error) return false;
  return !/^(22|23|42)/.test(error.code ?? '');
}

// The background task and the foreground watch can both write. Running every
// read-modify-write through one chain stops them overwriting each other.
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work);
  chain = run.catch(() => {});
  return run;
}

async function read(vehicleId: string): Promise<Buffered[]> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(vehicleId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt buffer is worth less than a working app.
    return [];
  }
}

const write = (vehicleId: string, rows: Buffered[]) =>
  rows.length
    ? AsyncStorage.setItem(keyFor(vehicleId), JSON.stringify(rows))
    : AsyncStorage.removeItem(keyFor(vehicleId));

/** Keep one position for later. Never throws: losing it is better than crashing. */
export function bufferPosition(row: PositionRow): Promise<void> {
  return serialize(async () => {
    try {
      const rows = await read(row.vehicle_id);
      rows.push({
        lat: row.lat,
        lng: row.lng,
        speed: row.speed,
        heading: row.heading,
        recorded_at: row.updated_at,
      });
      await write(row.vehicle_id, rows.slice(-MAX_BUFFERED));
    } catch (e) {
      console.warn('[offline] could not keep position:', (e as Error)?.message ?? e);
    }
  });
}

export function bufferedCount(vehicleId: string): Promise<number> {
  return serialize(async () => (await read(vehicleId)).length);
}

/**
 * Send what was kept, oldest first. Stops at the first failure and keeps the
 * rest for next time. Returns how many the server accepted.
 */
export function flushBuffer(vehicleId: string): Promise<number> {
  return serialize(async () => {
    let rows = await read(vehicleId);
    let accepted = 0;

    while (rows.length > 0) {
      const batch = rows.slice(0, BATCH);
      const { data, error } = await supabase.rpc('record_buffered_positions', {
        p_vehicle_id: vehicleId,
        p_points: batch,
      });
      if (error) {
        // A refusal that will not change (not your vehicle, malformed) means
        // these can never be sent; drop them rather than retry forever.
        if (!shouldBuffer(error)) rows = rows.slice(batch.length);
        break;
      }
      accepted += Number(data ?? 0);
      rows = rows.slice(batch.length);
    }

    await write(vehicleId, rows);
    return accepted;
  });
}

let lastFlushAt = 0;

/** Called after every successful live position: flush, but not too often. */
export async function flushIfDue(vehicleId: string, now = Date.now()): Promise<void> {
  if (now - lastFlushAt < FLUSH_INTERVAL_MS) return;
  lastFlushAt = now;
  try {
    if ((await bufferedCount(vehicleId)) > 0) {
      const n = await flushBuffer(vehicleId);
      if (n > 0) console.log(`[offline] sent ${n} position(s) recorded without signal`);
    }
  } catch (e) {
    console.warn('[offline] flush failed:', (e as Error)?.message ?? e);
  }
}

/** For tests. */
export function resetFlushClock(): void {
  lastFlushAt = 0;
}
