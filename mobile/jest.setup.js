// Any module that reaches src/config needs these present, or importing it
// throws before a single assertion runs. Values are dummies; no test performs
// real network calls.
process.env.EXPO_PUBLIC_SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'test-anon-key';

// AsyncStorage is a native module and is unavailable in the test environment.
// The package ships an official mock for exactly this.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// config.ts reads the app config through expo-constants; tests drive it via
// process.env, so extra is empty here.
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

jest.mock('expo-location', () => ({
  Accuracy: { Lowest: 1, Low: 2, Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 },
  requestForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  requestBackgroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  startLocationUpdatesAsync: jest.fn(),
  stopLocationUpdatesAsync: jest.fn(),
  hasStartedLocationUpdatesAsync: jest.fn(),
  // The dashboard watches position to follow the driver; without this the
  // screen awaits a promise that never settles and the test hangs.
  watchPositionAsync: jest.fn().mockResolvedValue({ remove: jest.fn() }),
  getCurrentPositionAsync: jest.fn().mockResolvedValue({ coords: { latitude: 12.97, longitude: 77.59, speed: 0, heading: 0 } }),
}));

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn().mockResolvedValue(false),
}));

jest.mock('expo-notifications', () => ({
  AndroidImportance: { MAX: 5, HIGH: 4, DEFAULT: 3 },
  AndroidNotificationPriority: { MAX: 'max', HIGH: 'high' },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn().mockResolvedValue(null),
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  scheduleNotificationAsync: jest.fn().mockResolvedValue('id'),
}));
