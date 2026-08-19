import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Records fatal JavaScript errors so the next launch can show what happened.
 *
 * A crash on a phone leaves nothing behind: the app simply disappears, and
 * without a device on hand there is no way to see why. Persisting the error
 * turns "it closed itself" into a stack trace.
 *
 * This catches JavaScript faults only. A native crash - a GPU fault in the map
 * renderer, or the OS reclaiming memory - kills the process before any handler
 * runs, so an empty report is itself informative: it points at native rather
 * than JS.
 */

const KEY = 'sutra:last-crash';

export type CrashReport = { message: string; stack: string; at: string; fatal: boolean };

export async function readLastCrash(): Promise<CrashReport | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CrashReport) : null;
  } catch {
    return null;
  }
}

export async function clearLastCrash(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // Nothing useful to do if storage itself is failing.
  }
}

export async function recordCrash(error: unknown, fatal: boolean): Promise<void> {
  const err = error as Error;
  try {
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({
        message: err?.message ?? String(error),
        stack: (err?.stack ?? '').slice(0, 4000),
        at: new Date().toISOString(),
        fatal,
      }),
    );
  } catch {
    // Storage failing during a crash is not worth a second crash.
  }
}

/** Install once, at module scope, so it is armed before any screen renders. */
export function installCrashHandler(): void {
  const globalAny = global as any;
  const previous = globalAny.ErrorUtils?.getGlobalHandler?.();

  globalAny.ErrorUtils?.setGlobalHandler?.((error: unknown, isFatal?: boolean) => {
    // Written before delegating, since the default handler ends the process.
    void recordCrash(error, !!isFatal);
    previous?.(error, isFatal);
  });

  // An unhandled rejection is the most likely way this app dies: every network
  // call returns a promise, and one missing catch is enough.
  const rejectionTracking = globalAny.__DEV__
    ? null
    : require('promise/setimmediate/rejection-tracking');
  rejectionTracking?.enable({
    allRejections: true,
    onUnhandled: (_id: number, error: unknown) => void recordCrash(error, false),
    onHandled: () => {},
  });
}
