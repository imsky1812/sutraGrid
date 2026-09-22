import { useState } from 'react';
import {
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { supabase } from '../src/supabase';
import { Badge, Field, Label, PillButton } from '../src/ui';
import { color, space, type } from '../src/theme';

export default function Login() {
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(mode: 'signIn' | 'signUp') {
    setError(null);
    setNotice(null);

    if (!email.trim()) return setError('Enter the email your fleet account uses.');
    if (password.length < 6) return setError('Passwords are at least 6 characters.');

    setBusy(true);
    const credentials = { email: email.trim(), password };
    const { data, error: authError } =
      mode === 'signIn'
        ? await supabase.auth.signInWithPassword(credentials)
        : await supabase.auth.signUp(credentials);
    setBusy(false);

    if (authError) return setError(authError.message);

    // With email confirmation on, signUp returns a user but no session. Routing
    // onward would land on a screen the driver is not signed in for.
    if (!data.session) return setNotice('Confirm your email, then sign in.');

    router.replace('/vehicle-setup');
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      {/* Padding on both platforms: drawing edge to edge, Android no longer
          resizes the window for the keyboard, so nothing else lifts the form. */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.xl },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Badge label="Vehicle client" live />
            <Text style={type.display}>
              Live telemetry,{'\n'}
              <Text style={type.displayAccent}>straight from the road</Text>
            </Text>
            <Text style={type.muted}>
              Your position streams to traffic control only while a vehicle is on duty.
            </Text>
          </View>

          <View style={styles.form}>
            <Label>Email</Label>
            <Field
              placeholder="driver@example.com"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
              value={email}
              onChangeText={setEmail}
              editable={!busy}
            />

            <View style={styles.gap} />

            <Label>Password</Label>
            <Field
              placeholder="At least 6 characters"
              secureTextEntry
              autoComplete="current-password"
              textContentType="password"
              value={password}
              onChangeText={setPassword}
              editable={!busy}
            />
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}

          <View style={styles.actions}>
            <PillButton label="Sign in" glyph="✦" busy={busy} onPress={() => submit('signIn')} />
            <PillButton
              label="Create an account"
              variant="surface"
              disabled={busy}
              onPress={() => submit('signUp')}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.canvas },
  flex: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', padding: space.xl, gap: space.xl },
  header: { gap: space.md },
  form: { gap: space.sm },
  gap: { height: space.md },
  actions: { gap: space.md },
  error: { color: color.danger, fontSize: 13 },
  notice: { color: color.success, fontSize: 13 },
});
