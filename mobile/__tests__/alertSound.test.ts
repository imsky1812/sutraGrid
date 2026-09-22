import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import {
  ALERT_CHANNEL,
  ALERT_SOUND,
  announceAlert,
  notificationFor,
  prepareAlertSound,
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

beforeEach(() => jest.clearAllMocks());

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
