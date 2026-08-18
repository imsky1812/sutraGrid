/**
 * Runtime configuration, read from EXPO_PUBLIC_* environment variables.
 *
 * Expo inlines EXPO_PUBLIC_* values into the bundle at build time, so anything
 * here ends up readable inside the APK. That is expected for the Supabase anon
 * key, which is publishable and constrained by row-level security. Never put a
 * service_role key here.
 *
 * This deliberately does not throw. Throwing at module load happens before React
 * can render anything, so on a device it is an instant crash with no message and
 * nothing to go on. Instead the missing names are collected and the app shows
 * them on screen.
 */

const REQUIRED = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'] as const;

export const missingConfig: string[] = REQUIRED.filter((name) => !process.env[name]);

export const config = {
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
};
