import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SessionProvider } from '../src/session';
import { missingConfig } from '../src/config';
import { clearLastCrash, CrashReport, installCrashHandler, readLastCrash } from '../src/crashlog';
import { ErrorBoundary } from '../src/ErrorBoundary';
import { color, radius, space, type } from '../src/theme';

// Armed at module scope so it covers failures during the first render.
installCrashHandler();

export default function RootLayout() {
  const [crash, setCrash] = useState<CrashReport | null>(null);

  useEffect(() => {
    // Shown once, then cleared, so a stale report does not greet every launch.
    readLastCrash().then(setCrash);
  }, []);

  // A build without its environment variables used to crash before rendering.
  // Saying so on screen turns a silent failure into something diagnosable from
  // the device itself.
  if (missingConfig.length > 0) {
    return (
      <View style={styles.error}>
        <Text style={styles.title}>Configuration missing</Text>
        <Text style={styles.body}>
          This build was made without: {missingConfig.join(', ')}.
        </Text>
        <Text style={styles.body}>
          Set them on the EAS environment used by the build profile, then rebuild.
        </Text>
      </View>
    );
  }

  if (crash) {
    return (
      <View style={styles.error}>
        <Text style={styles.title}>The app closed unexpectedly</Text>
        <Text style={styles.body}>{new Date(crash.at).toLocaleString()}</Text>
        <ScrollView style={styles.trace}>
          <Text style={styles.mono}>{crash.message}</Text>
          <Text style={styles.mono}>{crash.stack}</Text>
        </ScrollView>
        <Pressable
          style={styles.dismiss}
          onPress={() => {
            clearLastCrash();
            setCrash(null);
          }}
        >
          <Text style={styles.dismissText}>Continue</Text>
        </Pressable>
      </View>
    );
  }

  return (
    // The bottom sheet on the dashboard needs this at the root, not around the
    // sheet itself.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>
        <SessionProvider>
          <Stack screenOptions={{ headerShown: false }} />
        </SessionProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  error: {
    flex: 1,
    backgroundColor: color.canvas,
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  title: { ...type.title, color: color.danger },
  body: { ...type.muted },
  trace: {
    maxHeight: '55%',
    backgroundColor: color.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.line,
    padding: space.md,
  },
  mono: { color: color.ink, fontSize: 11, fontFamily: 'monospace', marginBottom: space.sm },
  dismiss: {
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    padding: space.lg,
    alignItems: 'center',
  },
  dismissText: { color: color.onAccent, fontWeight: '700' },
});
