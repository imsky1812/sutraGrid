import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { listMyVehicles, registerVehicle, validateVehicleNumber, Vehicle } from '../src/vehicles';
import { supabase } from '../src/supabase';
import { AccentAction, Badge, Card, Field, Label, PillButton } from '../src/ui';
import { color, radius, space, type } from '../src/theme';

const TYPE_GLYPH: Record<string, string> = {
  NORMAL: '🚗',
  AMBULANCE: '🚑',
  POLICE: '🚓',
  FIRE: '🚒',
};

export default function VehicleSetup() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [driverName, setDriverName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    listMyVehicles()
      .then(setVehicles)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function add() {
    const problem = validateVehicleNumber(vehicleNumber);
    if (problem) return setError(problem);
    if (!driverName.trim()) return setError('Add the driver name for this vehicle.');

    setError(null);
    setBusy(true);
    try {
      const created = await registerVehicle({ vehicleNumber, driverName });
      setVehicles((current) => [...current, created]);
      setVehicleNumber('');
      setAdding(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <View style={[styles.screen, styles.centre]}>
        <ActivityIndicator color={color.accent} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <View style={styles.flex}>
          <Text style={type.caption}>ON DUTY AS</Text>
          <Text style={type.title}>Choose a vehicle</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          onPress={async () => {
            await supabase.auth.signOut();
            router.replace('/login');
          }}
          style={styles.signOut}
        >
          <Text style={styles.signOutGlyph}>⏻</Text>
        </Pressable>
      </View>

      <FlatList
        data={vehicles}
        keyExtractor={(v) => v.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Card style={styles.empty}>
            <Text style={type.section}>No vehicles yet</Text>
            <Text style={type.muted}>
              Register the vehicle you are driving to start streaming telemetry.
            </Text>
          </Card>
        }
        renderItem={({ item }) => (
          <Card
            style={styles.vehicleCard}
            onPress={() =>
              router.replace({ pathname: '/dashboard', params: { vehicleId: item.id } })
            }
          >
            <View style={styles.vehicleTop}>
              <View style={styles.flex}>
                {item.is_emergency_authorized ? (
                  <Badge label="Emergency authorized" live />
                ) : (
                  <Badge label={item.vehicle_type} />
                )}
                <Text style={styles.vehicleNumber}>{item.vehicle_number}</Text>
                <Text style={type.muted}>
                  {item.driver_name} · reports every{' '}
                  {item.is_emergency_authorized ? '1s' : '3s'}
                </Text>
              </View>
              <Text style={styles.vehicleGlyph}>{TYPE_GLYPH[item.vehicle_type] ?? '🚗'}</Text>
            </View>

            <View style={styles.vehicleBottom}>
              <Text style={type.caption}>START SHIFT</Text>
              <AccentAction
                label={`Start shift in ${item.vehicle_number}`}
                onPress={() =>
                  router.replace({ pathname: '/dashboard', params: { vehicleId: item.id } })
                }
              />
            </View>
          </Card>
        )}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
      >
        <ScrollView
          style={styles.footerScroll}
          contentContainerStyle={styles.footer}
          keyboardShouldPersistTaps="handled"
        >
          {error ? <Text style={styles.error}>{error}</Text> : null}

        {adding ? (
          <Card style={styles.form}>
            <Label>Vehicle number</Label>
            <Field
              placeholder="KA-03-AB-1234"
              autoCapitalize="characters"
              value={vehicleNumber}
              onChangeText={setVehicleNumber}
              editable={!busy}
            />
            <Label>Driver name</Label>
            <Field
              placeholder="Full name"
              value={driverName}
              onChangeText={setDriverName}
              editable={!busy}
            />
            <Text style={styles.hint}>
              Emergency status is granted by an administrator and cannot be set here.
            </Text>
            <PillButton label="Register vehicle" glyph="✦" busy={busy} onPress={add} />
            <PillButton
              label="Cancel"
              variant="surface"
              disabled={busy}
              onPress={() => {
                setAdding(false);
                setError(null);
              }}
            />
          </Card>
        ) : (
          <PillButton label="Register a vehicle" glyph="＋" onPress={() => setAdding(true)} />
        )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.canvas },
  centre: { alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingTop: space.xxl + space.lg,
    paddingBottom: space.lg,
  },
  signOut: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  signOutGlyph: { color: color.muted, fontSize: 16 },

  list: { paddingHorizontal: space.xl, paddingBottom: space.lg, gap: space.md },
  empty: { gap: space.sm },

  vehicleCard: { gap: space.lg },
  vehicleTop: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  vehicleNumber: {
    ...type.title,
    fontSize: 22,
    marginTop: space.sm,
  },
  vehicleGlyph: { fontSize: 30 },
  vehicleBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: color.line,
    paddingTop: space.md,
  },

  // Capped so the form can scroll clear of the keyboard without pushing the
  // fleet list off screen.
  footerScroll: { maxHeight: '62%' },
  footer: { padding: space.xl, gap: space.md, paddingBottom: space.xxl },
  form: { gap: space.sm },
  hint: { ...type.muted, fontSize: 11.5 },
  error: { color: color.danger, fontSize: 13 },
});
