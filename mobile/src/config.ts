import Constants from 'expo-constants';

/**
 * Runtime configuration.
 *
 * Values come from the app config's `extra`, which is baked into the bundle at
 * build time and therefore always present. EXPO_PUBLIC_* environment variables
 * still take precedence when set, so local development and CI can override.
 *
 * Environment variables alone proved unreliable: two EAS builds shipped without
 * them despite the variables existing and the profile binding to the right
 * environment. `extra` cannot go missing, because it is part of the config the
 * bundle is built from.
 *
 * This deliberately does not throw. Throwing at module load happens before React
 * can render, so on a device it is a crash with no message. The missing names
 * are collected instead and shown on screen.
 */

type Extra = { supabaseUrl?: string; supabaseAnonKey?: string };

const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || extra.supabaseUrl || '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || extra.supabaseAnonKey || '';

export const missingConfig: string[] = [
  ...(supabaseUrl ? [] : ['EXPO_PUBLIC_SUPABASE_URL']),
  ...(supabaseAnonKey ? [] : ['EXPO_PUBLIC_SUPABASE_ANON_KEY']),
];

export const config = { supabaseUrl, supabaseAnonKey };
