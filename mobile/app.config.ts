import type { ExpoConfig } from 'expo/config';

/**
 * Replaces app.json so the Maps key can come from the environment rather than
 * being committed. The Kotlin client's package name is reused deliberately: an
 * existing SHA-1-restricted Maps key stays valid.
 */
const config: ExpoConfig = {
  name: 'SUTRA Vehicle',
  slug: 'sutra-vehicle',
  // EAS account that owns the project. Set here rather than passed as
  // --account each time, since the login has access to more than one.
  owner: 'imsky1812s-org',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  scheme: 'sutra',
  // The app is dark-only by design; a light system theme would fight the map.
  userInterfaceStyle: 'dark',
  backgroundColor: '#0D0F0B',

  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.sutra.vehicle',
  },

  android: {
    package: 'com.sutra.vehicle',
    adaptiveIcon: {
      // Matches the generated background layer and the app canvas. The template
      // default was a light blue, which fought the dark mark on launchers that
      // ignore the background image.
      backgroundColor: '#0D0F0B',
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

  // Written by hand because `eas init` cannot modify a dynamic config.
  // Not a secret - it appears in the public project URL.
  extra: {
    eas: {
      projectId: 'a6814d09-f918-4a62-98c8-ceba323a2e9a',
    },
  },

  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-system-ui',
    [
      'expo-splash-screen',
      {
        // The mark on the app canvas, so launch and first screen are continuous.
        image: './assets/splash-icon.png',
        imageWidth: 180,
        resizeMode: 'contain',
        backgroundColor: '#0D0F0B',
      },
    ],
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
