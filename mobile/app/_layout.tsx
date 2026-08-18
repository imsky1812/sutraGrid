import { Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SessionProvider } from '../src/session';
import { missingConfig } from '../src/config';
import { color, space, type } from '../src/theme';

export default function RootLayout() {
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

  return (
    // The bottom sheet on the dashboard needs this at the root, not around the
    // sheet itself.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SessionProvider>
        <Stack screenOptions={{ headerShown: false }} />
      </SessionProvider>
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
});
