import type { ExpoConfig } from 'expo/config';

/**
 * Replaces app.json so the Maps key can come from the environment rather than
 * being committed. The Kotlin client's package name is reused deliberately: an
 * existing SHA-1-restricted Maps key stays valid.
 */
const config: ExpoConfig = {
  name: 'SUTRA Vehicle',
  slug: 'sutra-vehicle',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  scheme: 'sutra',
  userInterfaceStyle: 'light',

  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.sutra.vehicle',
  },

  android: {
    package: 'com.sutra.vehicle',
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    permissions: [
      'ACCESS_COARSE_LOCATION',
      'ACCESS_FINE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
      'POST_NOTIFICATIONS',
    ],
    config: {
      googleMaps: {
        // Supplied at build time. Absent until the key is provisioned, in which
        // case the map renders grey but the rest of the app still works.
        apiKey: process.env.GOOGLE_MAPS_ANDROID_KEY ?? '',
      },
    },
  },

  web: {
    favicon: './assets/favicon.png',
  },

  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-location',
      {
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
        locationAlwaysAndWhenInUsePermission:
          'SUTRA shares your location with traffic control while you are on duty.',
      },
    ],
  ],
};

export default config;
