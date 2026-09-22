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
};

// Without a handler, a notification raised while the app is open is dropped
// silently, and the app is open for most of a shift.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
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

/**
 * Beep, vibrate and post a notification for one alert. Deliberately needs no
 * interaction: a driver should never have to touch the phone to hear it.
 */
export async function announceAlert(alert: Alert): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: notificationFor(alert),
      trigger: Platform.OS === 'android' ? { channelId: ALERT_CHANNEL } : null,
    });
  } catch (e) {
    console.warn('[alerts] could not announce alert:', (e as Error)?.message ?? e);
  }
}
