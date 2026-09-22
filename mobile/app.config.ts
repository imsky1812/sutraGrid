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
    // No maps API key: tiles come from OpenFreeMap and routing from OSRM,
    // neither of which needs one.
  },

  web: {
    favicon: './assets/favicon.png',
  },

  extra: {
    // Written by hand because `eas init` cannot modify a dynamic config.
    // Not a secret - it appears in the public project URL.
    eas: {
      projectId: 'a6814d09-f918-4a62-98c8-ceba323a2e9a',
    },

    // Supabase connection, committed deliberately.
    //
    // These were previously supplied through EAS environment variables. Two
    // builds shipped without them: the variables existed, the profile declared
    // `environment: preview`, and `eas config` confirmed they loaded - yet they
    // were absent at bundle time. Rather than keep guessing at that mechanism,
    // the values live here, where they cannot go missing.
    //
    // Safe to commit: the anon key is publishable by design and constrained by
    // row-level security, and it is extractable from any APK we distribute, so
    // committing it exposes nothing a download would not. A service_role key
    // must never be added here.
    //
    // The environment still wins when set, so local development and any future
    // EAS environment keep working.
    supabaseUrl:
      process.env.EXPO_PUBLIC_SUPABASE_URL ?? 'https://ytqpjxpzhgintwpbujcy.supabase.co',
    supabaseAnonKey:
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl0cXBqeHB6aGdpbnR3cGJ1amN5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwMTc2NjAsImV4cCI6MjEwMjU5MzY2MH0.SvD4RDu4K_e1Sz2YlGeaxhFQg7nxAE-TYlpqMWuFj6g',
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
    [
      'expo-notifications',
      {
        color: '#D7F94A',
        // Bundled as a raw resource so the alert channel can use it. Regenerate
        // with scripts/generate-beep.mjs.
        sounds: ['./assets/sounds/alert_beep.wav'],
      },
    ],
  ],
};

export default config;
