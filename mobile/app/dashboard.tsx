import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { router, useLocalSearchParams } from 'expo-router';
import { listMyVehicles, Vehicle } from '../src/vehicles';
import { setAlertMessage, setDestination, startTelemetry, stopTelemetry } from '../src/telemetry';
import { fetchRoute } from '../src/directions';
import { darkMapStyle } from '../src/mapStyle';
import type { LatLng } from '../src/polyline';

const BANGALORE = { latitude: 12.9716, longitude: 77.5946 };

const PRESET_DESTINATIONS = [
  { name: 'City General Hospital', latitude: 12.976, longitude: 77.601 },
  { name: 'Central Fire Station', latitude: 12.975, longitude: 77.589 },
  { name: 'Metro Police Headquarters', latitude: 12.969, longitude: 77.591 },
];

export default function Dashboard() {
  const { vehicleId } = useLocalSearchParams<{ vehicleId: string }>();

  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [loading, setLoading] = useState(true);
  const [route, setRoute] = useState<LatLng[]>([]);
  const [destLat, setDestLat] = useState('');
  const [destLng, setDestLng] = useState('');
  const [destName, setDestName] = useState('');
  const [alerting, setAlerting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routing, setRouting] = useState(false);

  const sheetRef = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ['24%', '78%'], []);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const vehicles = await listMyVehicles();
        const found = vehicles.find((v) => v.id === vehicleId) ?? null;
        if (!active) return;

        if (!found) {
          // RLS means the list only ever contains this user's vehicles, so a
          // miss here is a bad id rather than a permissions problem.
          setError('Vehicle not found. It may belong to another account.');
          setLoading(false);
          return;
        }

        setVehicle(found);
        setLoading(false);
        await startTelemetry(found);
      } catch (e) {
        if (active) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    })();

    return () => {
      active = false;
      // The foreground service must not outlive the screen that started it.
      stopTelemetry();
    };
  }, [vehicleId]);

  const applyDestination = useCallback(
    async (target: { latitude: number; longitude: number; name: string }) => {
      setError(null);
      setRouting(true);
      setDestination(target);
      setDestLat(String(target.latitude));
      setDestLng(String(target.longitude));
      setDestName(target.name);

      try {
        setRoute(await fetchRoute(BANGALORE, target));
      } catch (e) {
        setRoute([]);
        setError((e as Error).message);
      } finally {
        setRouting(false);
      }
    },
    [],
  );

  function applyTypedDestination() {
    const latitude = Number(destLat);
    const longitude = Number(destLng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return setError('Enter a valid latitude and longitude.');
    }
    applyDestination({ latitude, longitude, name: destName || 'Custom destination' });
  }

  function clearRoute() {
    setRoute([]);
    setDestLat('');
    setDestLng('');
    setDestName('');
    setDestination(null);
  }

  function toggleAlert() {
    const next = !alerting;
    setAlerting(next);
    setAlertMessage(
      next ? `ALERT: Emergency vehicle (${vehicle?.vehicle_number}) approaching. Yield lane.` : null,
    );
  }

  if (loading) return <ActivityIndicator style={styles.centred} />;

  if (!vehicle) {
    return (
      <View style={styles.centredBox}>
        <Text style={styles.error}>{error ?? 'Vehicle not found.'}</Text>
        <Pressable style={styles.button} onPress={() => router.replace('/vehicle-setup')}>
          <Text style={styles.buttonText}>Back to vehicles</Text>
        </Pressable>
      </View>
    );
  }

  const hasDestination = destLat !== '' && destLng !== '';

  return (
    <View style={styles.container}>
      <MapView
        style={StyleSheet.absoluteFill}
        customMapStyle={darkMapStyle}
        showsUserLocation
        initialRegion={{ ...BANGALORE, latitudeDelta: 0.05, longitudeDelta: 0.05 }}
      >
        {route.length > 0 && (
          <Polyline coordinates={route} strokeColor="#00f2fe" strokeWidth={6} />
        )}
        {hasDestination && (
          <Marker
            coordinate={{ latitude: Number(destLat), longitude: Number(destLng) }}
            title={destName || 'Destination'}
          />
        )}
      </MapView>

      <BottomSheet ref={sheetRef} index={0} snapPoints={snapPoints}>
        <BottomSheetScrollView contentContainerStyle={styles.sheet}>
          <Text style={styles.title}>{vehicle.vehicle_number}</Text>
          <Text style={styles.muted}>
            {vehicle.driver_name} · {vehicle.vehicle_type}
            {vehicle.is_emergency_authorized ? ' · EMERGENCY AUTHORIZED' : ''}
          </Text>
          <Text style={styles.muted}>
            Streaming every {vehicle.is_emergency_authorized ? '1' : '3'}s while on duty.
          </Text>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Text style={styles.section}>Destination</Text>
          <View style={styles.presetRow}>
            {PRESET_DESTINATIONS.map((d) => (
              <Pressable key={d.name} style={styles.chip} onPress={() => applyDestination(d)}>
                <Text style={styles.chipText}>{d.name}</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.row}>
            <TextInput
              style={[styles.input, styles.flex]}
              placeholder="Lat"
              placeholderTextColor="#999"
              keyboardType="numeric"
              value={destLat}
              onChangeText={setDestLat}
            />
            <TextInput
              style={[styles.input, styles.flex]}
              placeholder="Lng"
              placeholderTextColor="#999"
              keyboardType="numeric"
              value={destLng}
              onChangeText={setDestLng}
            />
          </View>

          <Pressable
            style={[styles.button, routing && styles.disabled]}
            onPress={applyTypedDestination}
            disabled={routing}
          >
            <Text style={styles.buttonText}>{routing ? 'Routing…' : 'Set destination'}</Text>
          </Pressable>

          {hasDestination ? (
            <Pressable style={[styles.button, styles.secondary]} onPress={clearRoute}>
              <Text style={styles.buttonText}>Clear route</Text>
            </Pressable>
          ) : null}

          {/* Offered only when an administrator has authorized this vehicle,
              rather than shown and then refused. */}
          {vehicle.is_emergency_authorized ? (
            <>
              <Text style={styles.section}>Emergency corridor</Text>
              <Pressable
                style={[styles.button, alerting ? styles.danger : styles.secondary]}
                onPress={toggleAlert}
              >
                <Text style={styles.buttonText}>
                  {alerting ? 'Cancel Clear-Path Broadcast' : 'Broadcast Emergency Clear-Path'}
                </Text>
              </Pressable>
            </>
          ) : null}

          <Pressable
            style={[styles.button, styles.secondary]}
            onPress={async () => {
              await stopTelemetry();
              router.replace('/vehicle-setup');
            }}
          >
            <Text style={styles.buttonText}>Stop streaming</Text>
          </Pressable>
        </BottomSheetScrollView>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centred: { flex: 1 },
  centredBox: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  sheet: { padding: 16, gap: 10, paddingBottom: 40 },
  title: { fontSize: 20, fontWeight: '700' },
  section: { fontSize: 15, fontWeight: '700', marginTop: 10 },
  muted: { color: '#666', fontSize: 12 },
  row: { flexDirection: 'row', gap: 8 },
  flex: { flex: 1 },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderWidth: 1,
    borderColor: '#0b6bcb',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipText: { color: '#0b6bcb', fontSize: 12 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12 },
  button: { backgroundColor: '#0b6bcb', borderRadius: 8, padding: 14, alignItems: 'center' },
  secondary: { backgroundColor: '#555' },
  danger: { backgroundColor: '#c0392b' },
  disabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontWeight: '600' },
  error: { color: '#c0392b', fontSize: 13 },
});
