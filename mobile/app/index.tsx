import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useSession } from '../src/session';

/** Auth gate: waits for the stored session to resolve before choosing a route. */
export default function Index() {
  const { session, loading } = useSession();

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  return <Redirect href={session ? '/vehicle-setup' : '/login'} />;
}
