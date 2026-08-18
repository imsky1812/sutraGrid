import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { listMyVehicles, registerVehicle, validateVehicleNumber, Vehicle } from '../src/vehicles';
import { supabase } from '../src/supabase';

export default function VehicleSetup() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
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
    if (!driverName.trim()) return setError('Driver name is required.');

    setError(null);
    setBusy(true);
    try {
      const created = await registerVehicle({ vehicleNumber, driverName });
      setVehicles((current) => [...current, created]);
      setVehicleNumber('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <ActivityIndicator style={styles.centred} />;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Select a vehicle</Text>
        <Pressable
          onPress={async () => {
            await supabase.auth.signOut();
            router.replace('/login');
          }}
        >
          <Text style={styles.link}>Sign out</Text>
        </Pressable>
      </View>

      <FlatList
        data={vehicles}
        keyExtractor={(v) => v.id}
        ListEmptyComponent={<Text style={styles.muted}>No vehicles registered yet.</Text>}
        renderItem={({ item }) => (
          <Pressable
            style={styles.card}
            onPress={() =>
              router.replace({ pathname: '/dashboard', params: { vehicleId: item.id } })
            }
          >
            <Text style={styles.cardTitle}>{item.vehicle_number}</Text>
            <Text style={styles.muted}>
              {item.driver_name} · {item.vehicle_type}
              {item.is_emergency_authorized ? ' · EMERGENCY AUTHORIZED' : ''}
            </Text>
          </Pressable>
        )}
      />

      <Text style={styles.title}>Register a new vehicle</Text>
      <TextInput
        style={styles.input}
        placeholder="Vehicle number"
        placeholderTextColor="#999"
        autoCapitalize="characters"
        value={vehicleNumber}
        onChangeText={setVehicleNumber}
        editable={!busy}
      />
      <TextInput
        style={styles.input}
        placeholder="Driver name"
        placeholderTextColor="#999"
        value={driverName}
        onChangeText={setDriverName}
        editable={!busy}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable style={[styles.button, busy && styles.disabled]} onPress={add} disabled={busy}>
        <Text style={styles.buttonText}>{busy ? 'Registering…' : 'Register'}</Text>
      </Pressable>

      <Text style={styles.muted}>
        Emergency status is granted by an administrator and cannot be set here.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 10, backgroundColor: '#fff' },
  centred: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 18, fontWeight: '700', marginTop: 8 },
  card: { padding: 14, borderWidth: 1, borderColor: '#ddd', borderRadius: 8, marginBottom: 8 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  muted: { color: '#666', fontSize: 12 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12 },
  button: { backgroundColor: '#0b6bcb', borderRadius: 8, padding: 14, alignItems: 'center' },
  disabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontWeight: '600' },
  link: { color: '#0b6bcb', fontSize: 13 },
  error: { color: '#c0392b', fontSize: 13 },
});
