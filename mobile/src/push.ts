import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { supabase } from './supabase';

/**
 * Tell the server which phone is in which vehicle, so an alert can reach it
 * with the app closed.
 *
 * Every alert also still arrives over Realtime while the app runs, so nothing
 * here is allowed to break a shift. If the token cannot be obtained - most
 * often because the build was made without Firebase configured, in which case
 * Android has no way to issue one - this logs why and reports it as not ready,
 * and the app carries on exactly as it did before push existed.
 */

export type PushStatus =
  | { ready: true; token: string }
  | { ready: false; reason: string };

/** The token this phone registered, so sign-out can withdraw it. */
let registeredToken: string | null = null;

/** The EAS project the token is issued for. Fixed in app.config.ts. */
function projectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? null;
}

export async function registerForPush(vehicleId: string): Promise<PushStatus> {
  try {
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) {
      // prepareAlertSound asked already; asking twice in a row just annoys.
      return { ready: false, reason: 'Notifications are turned off for SUTRA.' };
    }

    const id = projectId();
    if (!id) return { ready: false, reason: 'No EAS project id in this build.' };

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });

    const { error } = await supabase.rpc('register_push_token', {
      p_token: token,
      p_vehicle_id: vehicleId,
      p_platform: Platform.OS === 'ios' ? 'ios' : 'android',
    });
    if (error) return { ready: false, reason: error.message };

    registeredToken = token;
    return { ready: true, token };
  } catch (e) {
    const reason = (e as Error)?.message ?? String(e);
    // "Default FirebaseApp is not initialized" means google-services.json was
    // not in this build. Worth saying plainly in the log, since it is the one
    // cause that is fixed outside the code.
    console.warn('[push] not registered:', reason);
    return { ready: false, reason };
  }
}

/**
 * Stop this phone receiving alerts, on sign-out.
 *
 * Must run before signing out: the delete is limited by row-level security to
 * the caller's own devices, and once the session is gone there is no caller.
 * Otherwise a shared phone would go on receiving the last driver's alerts until
 * somebody else happened to sign in on it.
 */
export async function forgetThisDevice(): Promise<void> {
  const token = registeredToken;
  if (!token) return;
  try {
    const { error } = await supabase.from('device_tokens').delete().eq('token', token);
    if (error) throw new Error(error.message);
    registeredToken = null;
  } catch (e) {
    // Never hold up a sign-out over this.
    console.warn('[push] could not unregister:', (e as Error)?.message ?? e);
  }
}
