import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { CATEGORY_GLYPH, type Alert } from './alerts';

/**
 * Android fixes a channel's sound and importance the first time it is created
 * and ignores later changes, so a new id is needed if either ever changes.
 */
export const ALERT_CHANNEL = 'sutra-alerts-v1';
export const ALERT_SOUND = 'alert_beep.wav';

const CATEGORY_TITLE: Record<Alert['category'], string> = {
  CONGESTION: 'Congestion ahead',
  RULE: 'Rule warning',
  HAZARD: 'Hazard ahead',
  MESSAGE: 'Message from control',
  // Raised by a green corridor: an ambulance is coming up this road.
  EMERGENCY: 'Emergency vehicle approaching',
};

/**
 * One alert can now reach the phone twice: over Realtime while the app is
 * running, and as a push notification, which is sent regardless because
 * Realtime has been seen to die silently. Both carry this same identifier.
 *
 * On Android that identifier is the notification's tag (expo-notifications
 * posts local notifications with the request identifier as the tag, and uses a
 * push's `tag` field as its identifier), so the second one replaces the first
 * in the tray rather than stacking beside it. The server builds the same string
 * in supabase/functions/notify/handler.ts.
 */
export function alertTag(alertId: number): string {
  return `sutra-alert-${alertId}`;
}

/** Alerts this app has already sounded, so the second arrival stays quiet. */
const announced = new Set<number>();

function alertIdFromTag(identifier: string | undefined): number | null {
  const match = /^sutra-alert-(\d+)$/.exec(identifier ?? '');
  return match ? Number(match[1]) : null;
}

// Without a handler, a notification raised while the app is open is dropped
// silently, and the app is open for most of a shift.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const id = alertIdFromTag(notification.request.identifier);
    // Only some trigger shapes carry a type; a push's is always 'push'.
    const trigger = notification.request.trigger as { type?: string } | null;
    const isPush = trigger?.type === 'push';

    // The app already announced this one over Realtime; the push arriving
    // behind it would only beep a second time.
    if (isPush && id !== null && announced.has(id)) {
      return {
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: false,
        shouldShowList: false,
      };
    }
    if (isPush && id !== null) announced.add(id);

    return {
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    };
  },
});

/** What the driver sees and hears for one alert. */
export function notificationFor(alert: Alert): Notifications.NotificationContentInput {
  const title = /^overspeeding/i.test(alert.message)
    ? 'Overspeeding'
    : CATEGORY_TITLE[alert.category];

  return {
    title: `${CATEGORY_GLYPH[alert.category]} ${alert.severity === 'CRITICAL' ? 'URGENT: ' : ''}${title}`,
    body: alert.message,
    sound: ALERT_SOUND,
    priority: Notifications.AndroidNotificationPriority.MAX,
    data: { alertId: alert.id },
  };
}

/**
 * Create the alert channel. Call once at startup: on Android 13 and later the
 * notification permission prompt only appears after a channel exists.
 *
 * The channel matters more now: a push names it, and Android shows nothing at
 * all for a push whose channel the app has not created yet.
 */
export async function prepareAlertSound(): Promise<void> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(ALERT_CHANNEL, {
        name: 'Traffic alerts',
        description: 'Overspeeding, congestion and hazard warnings from traffic control.',
        importance: Notifications.AndroidImportance.MAX,
        sound: ALERT_SOUND,
        vibrationPattern: [0, 400, 200, 400, 200, 400],
        lightColor: '#D7F94A',
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
    }

    const current = await Notifications.getPermissionsAsync();
    if (!current.granted) await Notifications.requestPermissionsAsync();
  } catch (e) {
    // Alerts still show on screen without this; never block the shift on it.
    console.warn('[alerts] could not prepare alert sound:', (e as Error)?.message ?? e);
  }
}

/** Already in the tray, most likely because the push got here first. */
async function alreadyShowing(alertId: number): Promise<boolean> {
  try {
    const shown = await Notifications.getPresentedNotificationsAsync();
    return shown.some((n) => n.request.identifier === alertTag(alertId));
  } catch {
    // Not knowing is not a reason to stay silent about an alert.
    return false;
  }
}

/**
 * Beep, vibrate and post a notification for one alert. Deliberately needs no
 * interaction: a driver should never have to touch the phone to hear it.
 */
export async function announceAlert(alert: Alert): Promise<void> {
  if (announced.has(alert.id)) return;
  announced.add(alert.id);

  // A push that arrived while the app was in the background is presented by
  // Android directly, without passing through the handler above, so it has to
  // be looked for in the tray.
  if (await alreadyShowing(alert.id)) return;

  try {
    await Notifications.scheduleNotificationAsync({
      identifier: alertTag(alert.id),
      content: notificationFor(alert),
      trigger: Platform.OS === 'android' ? { channelId: ALERT_CHANNEL } : null,
    });
  } catch (e) {
    console.warn('[alerts] could not announce alert:', (e as Error)?.message ?? e);
  }
}

/** For tests: forget which alerts have been sounded. */
export function resetAnnounced(): void {
  announced.clear();
}
