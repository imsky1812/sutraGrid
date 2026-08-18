import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SessionProvider } from '../src/session';

export default function RootLayout() {
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
