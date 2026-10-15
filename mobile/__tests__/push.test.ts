// Registering this phone so alerts reach it with the app closed.
//
// The rule that matters most here: nothing in this file may break a shift.
// A build without Firebase configured cannot get a push token at all, and that
// must cost exactly push - not telemetry, not the map, not Realtime alerts.

const mockRpc = jest.fn();
const mockDelete = jest.fn();

jest.mock('../src/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => mockRpc(...a),
    from: () => ({ delete: () => ({ eq: (...a: unknown[]) => mockDelete(...a) }) }),
  },
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { eas: { projectId: 'project-123' } } }, easConfig: null },
}));

import * as Notifications from 'expo-notifications';
import { forgetThisDevice, registerForPush } from '../src/push';

const TOKEN = 'ExponentPushToken[testdevice0000001]';

beforeEach(() => {
  jest.clearAllMocks();
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockDelete.mockResolvedValue({ error: null });
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({ type: 'expo', data: TOKEN });
});

test('registers this phone to the vehicle it is driving', async () => {
  const status = await registerForPush('veh-1');
  expect(status).toEqual({ ready: true, token: TOKEN });
  expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'project-123' });
  expect(mockRpc).toHaveBeenCalledWith('register_push_token', {
    p_token: TOKEN,
    p_vehicle_id: 'veh-1',
    p_platform: expect.stringMatching(/^(android|ios)$/),
  });
});

// The common case until Firebase is set up: Android will not issue a token.
test('a build without Firebase reports why, and does not throw', async () => {
  (Notifications.getExpoPushTokenAsync as jest.Mock).mockRejectedValue(
    new Error('Default FirebaseApp is not initialized in this process'),
  );
  const status = await registerForPush('veh-1');
  expect(status).toEqual({ ready: false, reason: expect.stringMatching(/FirebaseApp/) });
  expect(mockRpc).not.toHaveBeenCalled();
});

test('does not nag for a permission that was already refused', async () => {
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
  const status = await registerForPush('veh-1');
  expect(status.ready).toBe(false);
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
});

test('a refusal from the server is reported', async () => {
  mockRpc.mockResolvedValue({ data: null, error: { message: 'Not your vehicle.' } });
  await expect(registerForPush('veh-9')).resolves.toEqual({ ready: false, reason: 'Not your vehicle.' });
});

describe('signing out', () => {
  // Otherwise a shared phone keeps receiving the last driver's alerts.
  test('withdraws the token this phone registered', async () => {
    await registerForPush('veh-1');
    await forgetThisDevice();
    expect(mockDelete).toHaveBeenCalledWith('token', TOKEN);
  });

  test('does nothing if this phone never registered', async () => {
    // A fresh copy of the module, so no earlier test's registration leaks in.
    let fresh: typeof forgetThisDevice = async () => {};
    jest.isolateModules(() => {
      fresh = require('../src/push').forgetThisDevice;
    });
    await fresh();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test('never holds up a sign-out', async () => {
    await registerForPush('veh-1');
    mockDelete.mockRejectedValue(new Error('offline'));
    await expect(forgetThisDevice()).resolves.toBeUndefined();
  });
});
