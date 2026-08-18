/**
 * Runtime configuration, read from EXPO_PUBLIC_* environment variables.
 *
 * Expo inlines EXPO_PUBLIC_* values into the bundle at build time, so anything
 * here ends up readable inside the APK. That is expected for the Supabase anon
 * key, which is designed to be public and is constrained by row-level security.
 * Never put a service_role key or a Directions key here — the Directions key
 * lives in the Edge Function's environment instead.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail loudly at startup. The alternative is a confusing 401 from Supabase
    // much later, far from the actual cause.
    throw new Error(`Missing ${name}. Copy mobile/.env.example to mobile/.env and fill it in.`);
  }
  return value;
}

export const config = {
  supabaseUrl: required('EXPO_PUBLIC_SUPABASE_URL'),
  supabaseAnonKey: required('EXPO_PUBLIC_SUPABASE_ANON_KEY'),
};
