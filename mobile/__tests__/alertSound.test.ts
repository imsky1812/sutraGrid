import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import {
  ALERT_CHANNEL,
  ALERT_SOUND,
  alertTag,
  announceAlert,
  notificationFor,
  prepareAlertSound,
  resetAnnounced,
} from '../src/alertSound';
import type { Alert } from '../src/alerts';

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: 7,
  vehicle_id: 'veh-1',
  category: 'CONGESTION',
  severity: 'WARNING',
  message: 'Jam on Outer Ring Road, take Hosur Road',
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  ...over,
});

// Registered once, at import. Captured before beforeEach clears the mock.
const { handleNotification } = (Notifications.setNotificationHandler as jest.Mock).mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  resetAnnounced();
});

describe('notificationFor', () => {
  it('titles a congestion alert and carries the message as the body', () => {
    const n = notificationFor(alert());
    expect(n.title).toContain('Congestion ahead');
    expect(n.body).toBe('Jam on Outer Ring Road, take Hosur Road');
  });

  it('titles a server speeding warning as overspeeding', () => {
    const n = notificationFor(
      alert({ category: 'RULE', message: 'Overspeeding: 95 km/h in a 80 km/h zone. Slow down.' }),
    );
    expect(n.title).toContain('Overspeeding');
  });

  it('titles a green-corridor warning so the driver knows to give way', () => {
    const n = notificationFor(
      alert({
        category: 'EMERGENCY',
        severity: 'CRITICAL',
        message: 'Emergency vehicle KA-01-AMB-0001 is approaching on your road. Keep left and give way.',
      }),
    );
    expect(n.title).toContain('Emergency vehicle approaching');
    expect(n.title).toContain('🚑');
  });

  it('marks a critical alert as urgent', () => {
    expect(notificationFor(alert({ severity: 'CRITICAL' })).title).toContain('URGENT');
  });

  it('plays the bundled beep', () => {
    expect(notificationFor(alert()).sound).toBe(ALERT_SOUND);
  });
});

describe('announceAlert', () => {
  it('posts the notification immediately on the alert channel', async () => {
    Platform.OS = 'android';
    await announceAlert(alert());
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: { channelId: ALERT_CHANNEL } }),
    );
  });

  // A failed notification must never take the driving screen down with it.
  it('swallows a notification failure', async () => {
    (Notifications.scheduleNotificationAsync as jest.Mock).mockRejectedValueOnce(new Error('denied'));
    await expect(announceAlert(alert())).resolves.toBeUndefined();
  });
});

describe('prepareAlertSound', () => {
  it('creates a max-importance channel with the beep', async () => {
    Platform.OS = 'android';
    await prepareAlertSound();
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
      ALERT_CHANNEL,
      expect.objectContaining({ sound: ALERT_SOUND, importance: Notifications.AndroidImportance.MAX }),
    );
  });

  it('asks for permission when it has not been granted', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });
    await prepareAlertSound();
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalled();
  });

  it('does not throw when the channel cannot be created', async () => {
    (Notifications.setNotificationChannelAsync as jest.Mock).mockRejectedValueOnce(new Error('x'));
    await expect(prepareAlertSound()).resolves.toBeUndefined();
  });
});

// One alert can now arrive twice: over Realtime while the app runs, and as a
// push, which is sent regardless because Realtime has been seen to die
// silently. The driver must hear it once.
describe('one alert, two routes', () => {
  const pushed = (id: number) =>
    ({ request: { identifier: alertTag(id), trigger: { type: 'push' }, content: {} } }) as never;

  // Android replaces a shown notification with the same tag, and the server
  // builds the same string. If these drift apart, the tray shows both.
  it('tags the notification with the same id the server pushes under', async () => {
    await announceAlert(alert({ id: 42 }));
    expect(alertTag(42)).toBe('sutra-alert-42');
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'sutra-alert-42' }),
    );
  });

  it('does not sound the same alert twice over Realtime', async () => {
    await announceAlert(alert({ id: 42 }));
    await announceAlert(alert({ id: 42 }));
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('silences a push for an alert the app already announced', async () => {
    await announceAlert(alert({ id: 42 }));
    const behaviour = await handleNotification(pushed(42));
    expect(behaviour.shouldPlaySound).toBe(false);
    expect(behaviour.shouldShowBanner).toBe(false);
  });

  it('lets a push through when the app had not heard of it', async () => {
    const behaviour = await handleNotification(pushed(43));
    expect(behaviour.shouldPlaySound).toBe(true);
    expect(behaviour.shouldShowBanner).toBe(true);
  });

  // ...and then the same alert arriving over Realtime must stay quiet.
  it('does not re-announce an alert that arrived first as a push', async () => {
    await handleNotification(pushed(44));
    await announceAlert(alert({ id: 44 }));
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  // A push that landed while the app was in the background never passed
  // through the handler; it is only visible in the tray.
  it('does not re-announce an alert already in the tray', async () => {
    (Notifications.getPresentedNotificationsAsync as jest.Mock).mockResolvedValueOnce([
      { request: { identifier: 'sutra-alert-45' } },
    ]);
    await announceAlert(alert({ id: 45 }));
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  // Not knowing what is in the tray is no reason to stay silent.
  it('still announces if the tray cannot be read', async () => {
    (Notifications.getPresentedNotificationsAsync as jest.Mock).mockRejectedValueOnce(new Error('x'));
    await announceAlert(alert({ id: 46 }));
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  // The app's own local notification passes through the same handler, and
  // must not be mistaken for a duplicate of itself.
  it('never silences the app’s own notification', async () => {
    await announceAlert(alert({ id: 47 }));
    const local = { request: { identifier: alertTag(47), trigger: { channelId: ALERT_CHANNEL }, content: {} } };
    expect((await handleNotification(local as never)).shouldPlaySound).toBe(true);
  });
});
