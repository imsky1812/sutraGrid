import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Location from 'expo-location';
import { Camera, GeoJSONSource, Layer, Map, Marker, UserLocation } from '@maplibre/maplibre-react-native';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { StatusBar } from 'expo-status-bar';
import { router, useLocalSearchParams } from 'expo-router';
import { listMyVehicles, Vehicle } from '../src/vehicles';
import { setAlertMessage, setDestination, startTelemetry, stopTelemetry } from '../src/telemetry';
import { fetchRoute } from '../src/directions';
import { describePoint, Place, searchPlaces } from '../src/places';
import {
  acknowledgeAlert,
  Alert as FleetAlert,
  CATEGORY_GLYPH,
  fetchActiveAlerts,
  subscribeToAlerts,
} from '../src/alerts';
import { MAP_STYLE_URL, ROUTE_COLOR, ROUTE_WIDTH } from '../src/mapStyle';
import { AccentAction, Badge, Card, Chip, Field, Label, NavBar, PillButton } from '../src/ui';
import { color, radius, shadow, space, type } from '../src/theme';
import type { LatLng } from '../src/polyline';

const BANGALORE = { latitude: 12.9716, longitude: 77.5946 };

const PRESETS = [
  { key: 'hospital', glyph: '🏥', name: 'City General Hospital', latitude: 12.976, longitude: 77.601 },
  { key: 'fire', glyph: '🚒', name: 'Central Fire Station', latitude: 12.975, longitude: 77.589 },
  { key: 'police', glyph: '🚓', name: 'Metro Police HQ', latitude: 12.969, longitude: 77.591 },
];

const NAV_ITEMS = [
  { key: 'route', glyph: '◎', label: 'Route' },
  { key: 'manual', glyph: '⌖', label: 'Manual coordinates' },
  { key: 'alert', glyph: '✦', label: 'Emergency corridor' },
];

export default function Dashboard() {
  const { vehicleId } = useLocalSearchParams<{ vehicleId: string }>();

  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [loading, setLoading] = useState(true);
  const [route, setRoute] = useState<LatLng[]>([]);
  const [destLat, setDestLat] = useState('');
  const [destLng, setDestLng] = useState('');
  const [destName, setDestName] = useState('');
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [alerting, setAlerting] = useState(false);
  const [routing, setRouting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pane, setPane] = useState('route');
  const [alerts, setAlerts] = useState<FleetAlert[]>([]);

  // The driver's own position. Routing starts from here rather than from a
  // hardcoded city centre, which was giving routes from the wrong place.
  const [here, setHere] = useState<{ latitude: number; longitude: number } | null>(null);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);

  const sheetRef = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ['30%', '82%'], []);

  useEffect(() => {
    let active = true;
    let unsubscribeAlerts: (() => void) | null = null;

    (async () => {
      try {
        const vehicles = await listMyVehicles();
        const found = vehicles.find((v) => v.id === vehicleId) ?? null;
        if (!active) return;

        if (!found) {
          // RLS means the list only ever holds this user's vehicles, so a miss
          // is a bad id rather than a permissions problem.
          setError('Vehicle not found. It may belong to another account.');
          setLoading(false);
          return;
        }

        setVehicle(found);
        setLoading(false);

        // Existing alerts first, so a driver opening mid-shift sees what is
        // already in force rather than only what arrives next.
        fetchActiveAlerts(found.id)
          .then((current) => {
            if (active) setAlerts(current);
          })
          .catch(() => {});

        unsubscribeAlerts = subscribeToAlerts(found.id, (alert) => {
          if (!active) return;
          setAlerts((current) => [alert, ...current.filter((a) => a.id !== alert.id)]);
          acknowledgeAlert(alert.id, found.id).catch(() => {});
        });

        await startTelemetry(found);
      } catch (e) {
        if (active) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    })();

    // The map used to sit on a fixed city centre. Watching position lets it
    // follow the driver and gives routing a real origin.
    let positionWatch: Location.LocationSubscription | null = null;
    Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Balanced, timeInterval: 4000, distanceInterval: 10 },
      (loc) => {
        if (active) {
          setHere({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
        }
      },
    )
      .then((sub) => {
        positionWatch = sub;
        // The screen may have unmounted while the subscription was being set up.
        if (!active) sub.remove();
      })
      .catch(() => {});

    return () => {
      active = false;
      positionWatch?.remove();
      unsubscribeAlerts?.();
      // The foreground service must not outlive the screen that started it.
      stopTelemetry();
    };
  }, [vehicleId]);

  const applyDestination = useCallback(
    async (target: { latitude: number; longitude: number; name: string }, presetKey?: string) => {
      setError(null);
      setRouting(true);
      setActivePreset(presetKey ?? null);
      setDestination(target);
      setDestLat(String(target.latitude));
      setDestLng(String(target.longitude));
      setDestName(target.name);

      try {
        setRoute(await fetchRoute(here ?? BANGALORE, target));
      } catch (e) {
        setRoute([]);
        setError((e as Error).message);
      } finally {
        setRouting(false);
      }
    },
    [here],
  );

  async function runSearch() {
    setError(null);
    setSearching(true);
    try {
      setPlaces(await searchPlaces(query, here ?? undefined));
    } catch (e) {
      setPlaces([]);
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  }

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
    setActivePreset(null);
    setDestination(null);
  }

  function toggleAlert() {
    const next = !alerting;
    setAlerting(next);
    setAlertMessage(
      next ? `ALERT: Emergency vehicle (${vehicle?.vehicle_number}) approaching. Yield lane.` : null,
    );
  }

  if (loading) {
    return (
      <View style={[styles.screen, styles.centre]}>
        <ActivityIndicator color={color.accent} />
      </View>
    );
  }

  if (!vehicle) {
    return (
      <View style={[styles.screen, styles.centre, { padding: space.xl, gap: space.lg }]}>
        <Text style={styles.error}>{error ?? 'Vehicle not found.'}</Text>
        <PillButton label="Back to vehicles" onPress={() => router.replace('/vehicle-setup')} />
      </View>
    );
  }

  const hasDestination = destLat !== '' && destLng !== '';

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />

      <Map
        style={StyleSheet.absoluteFill}
        mapStyle={MAP_STYLE_URL}
        attribution
        logo={false}
        // Long-press anywhere to set that point as the destination.
        onLongPress={(event: any) => {
          const coords = event?.geometry?.coordinates;
          if (!Array.isArray(coords) || coords.length < 2) return;
          const [longitude, latitude] = coords;
          setFollow(false);
          describePoint(latitude, longitude).then((name) =>
            applyDestination({ latitude, longitude, name }),
          );
        }}
        // Any pan hands control back to the driver, as on the phone map apps.
        onRegionIsChanging={(e: any) => {
          if (e?.properties?.isUserInteraction) setFollow(false);
        }}
      >
        <Camera
          zoom={15}
          center={
            follow && here
              ? [here.longitude, here.latitude]
              : [BANGALORE.longitude, BANGALORE.latitude]
          }
        />
        <UserLocation />

        {/* The route is the only saturated thing on the map, by design.
            GeoJSON is lon,lat — the reverse of the order used elsewhere here. */}
        {route.length > 1 && (
          <GeoJSONSource
            id="route"
            data={{
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: route.map((p) => [p.longitude, p.latitude]),
              },
            }}
          >
            <Layer
              id="route-line"
              type="line"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{ 'line-color': ROUTE_COLOR, 'line-width': ROUTE_WIDTH }}
            />
          </GeoJSONSource>
        )}

        {hasDestination && (
          <Marker id="destination" lngLat={[Number(destLng), Number(destLat)]}>
            <View style={styles.destinationPin} />
          </Marker>
        )}
      </Map>

      {/* Alerts from traffic control. Newest first, most recent on top. */}
      {alerts.length > 0 && (
        <View style={styles.alertStack}>
          {alerts.slice(0, 2).map((alert) => (
            <View
              key={alert.id}
              style={[
                styles.alertCard,
                alert.severity === 'CRITICAL' && styles.alertCritical,
              ]}
            >
              <Text style={styles.alertGlyph}>{CATEGORY_GLYPH[alert.category]}</Text>
              <View style={styles.flex}>
                <Text style={styles.alertCategory}>{alert.category}</Text>
                <Text style={styles.alertText}>{alert.message}</Text>
              </View>
              <AccentAction
                glyph="✕"
                label="Dismiss alert"
                onPress={() => setAlerts((current) => current.filter((a) => a.id !== alert.id))}
              />
            </View>
          ))}
        </View>
      )}

      {/* Floating status bar, echoing the reference's top search pill. */}
      <View style={styles.topBar}>
        <View style={styles.statusPill}>
          <View style={styles.liveDot} />
          <View style={styles.flex}>
            <Text style={styles.statusVehicle} numberOfLines={1}>
              {vehicle.vehicle_number}
            </Text>
            <Text style={styles.statusMeta} numberOfLines={1}>
              Streaming every {vehicle.is_emergency_authorized ? '1s' : '3s'}
            </Text>
          </View>
        </View>
        {!follow && here ? (
          <AccentAction glyph="◎" label="Recentre on my location" onPress={() => setFollow(true)} />
        ) : null}
        <AccentAction
          glyph="⏻"
          label="Stop streaming and choose another vehicle"
          onPress={async () => {
            await stopTelemetry();
            router.replace('/vehicle-setup');
          }}
        />
      </View>

      <BottomSheet
        ref={sheetRef}
        index={0}
        snapPoints={snapPoints}
        backgroundStyle={styles.sheetBg}
        handleIndicatorStyle={styles.sheetHandle}
      >
        <BottomSheetScrollView contentContainerStyle={styles.sheet}>
          <View style={styles.sheetHeader}>
            <View style={styles.flex}>
              {vehicle.is_emergency_authorized ? (
                <Badge label="Emergency authorized" live />
              ) : (
                <Badge label={vehicle.vehicle_type} />
              )}
              <Text style={styles.sheetTitle}>
                {destName || 'No destination set'}
              </Text>
              <Text style={type.muted}>
                {route.length > 0
                  ? `Route loaded · ${route.length} points`
                  : 'Pick a destination to draw a corridor.'}
              </Text>
            </View>
          </View>

          <NavBar items={NAV_ITEMS} activeKey={pane} onSelect={setPane} />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          {pane === 'route' ? (
            <View style={styles.pane}>
              <Label>Search a place</Label>
              <View style={styles.row}>
                <Field
                  style={styles.flex}
                  placeholder="Hospital, street, landmark…"
                  value={query}
                  onChangeText={setQuery}
                  returnKeyType="search"
                  onSubmitEditing={runSearch}
                />
                <PillButton
                  label={searching ? '…' : 'Find'}
                  busy={searching}
                  onPress={runSearch}
                />
              </View>

              {places.map((place) => (
                <Pressable
                  key={`${place.latitude},${place.longitude}`}
                  style={styles.result}
                  onPress={() => {
                    setPlaces([]);
                    setQuery('');
                    setFollow(false);
                    applyDestination(place);
                  }}
                >
                  <Text style={styles.resultName} numberOfLines={2}>
                    {place.name}
                  </Text>
                </Pressable>
              ))}

              <Text style={type.muted}>Or long-press anywhere on the map to set a destination.</Text>

              <Label>Frequent destinations</Label>
              <View style={styles.chipRow}>
                {PRESETS.map((p) => (
                  <Chip
                    key={p.key}
                    glyph={p.glyph}
                    label={p.name}
                    selected={activePreset === p.key}
                    onPress={() => applyDestination(p, p.key)}
                  />
                ))}
              </View>

              {routing ? <Text style={type.muted}>Finding a route…</Text> : null}
              {hasDestination ? (
                <PillButton label="Clear route" variant="surface" onPress={clearRoute} />
              ) : null}
            </View>
          ) : null}

          {pane === 'manual' ? (
            <View style={styles.pane}>
              <Label>Coordinates</Label>
              <View style={styles.row}>
                <Field
                  style={styles.flex}
                  placeholder="Latitude"
                  keyboardType="numeric"
                  value={destLat}
                  onChangeText={setDestLat}
                />
                <Field
                  style={styles.flex}
                  placeholder="Longitude"
                  keyboardType="numeric"
                  value={destLng}
                  onChangeText={setDestLng}
                />
              </View>
              <PillButton
                label="Set destination"
                glyph="✦"
                busy={routing}
                onPress={applyTypedDestination}
              />
            </View>
          ) : null}

          {pane === 'alert' ? (
            <View style={styles.pane}>
              {/* Offered only when an administrator has authorized this vehicle,
                  rather than shown and then refused. */}
              {vehicle.is_emergency_authorized ? (
                <>
                  <Label>Corridor broadcast</Label>
                  <Text style={type.muted}>
                    Tells traffic control this vehicle needs a clear path. Stays on until
                    you cancel it.
                  </Text>
                  <PillButton
                    label={
                      alerting
                        ? 'Cancel Clear-Path Broadcast'
                        : 'Broadcast Emergency Clear-Path'
                    }
                    variant={alerting ? 'danger' : 'accent'}
                    onPress={toggleAlert}
                  />
                </>
              ) : (
                <Card style={styles.locked}>
                  <Text style={type.section}>Not authorized</Text>
                  <Text style={type.muted}>
                    Corridor broadcasts are limited to vehicles an administrator has
                    authorized.
                  </Text>
                </Card>
              )}
            </View>
          ) : null}
        </BottomSheetScrollView>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.canvas },
  centre: { alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },

  topBar: {
    position: 'absolute',
    top: space.xxl + space.xl,
    left: space.lg,
    right: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  statusPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.surface,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.line,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    ...shadow.float,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.accent },

  alertStack: {
    position: 'absolute',
    top: space.xxl + space.xxl + space.xl,
    left: space.lg,
    right: space.lg,
    gap: space.sm,
  },
  alertCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.accent,
    padding: space.md,
    ...shadow.float,
  },
  alertCritical: { borderColor: color.danger },
  alertGlyph: { fontSize: 20 },
  alertCategory: { ...type.caption, color: color.accent },
  alertText: { color: color.ink, fontSize: 13, marginTop: 2 },
  destinationPin: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: color.accent,
    borderWidth: 3,
    borderColor: color.canvas,
  },
  statusVehicle: { color: color.ink, fontSize: 14, fontWeight: '700', letterSpacing: -0.2 },
  statusMeta: { color: color.muted, fontSize: 11 },

  sheetBg: { backgroundColor: color.surface, borderRadius: radius.sheet },
  sheetHandle: { backgroundColor: color.faint, width: 40 },
  sheet: { padding: space.xl, paddingBottom: space.xxl + space.xl, gap: space.lg },
  sheetHeader: { flexDirection: 'row', gap: space.md },
  sheetTitle: { ...type.title, fontSize: 21, marginTop: space.sm },

  pane: { gap: space.md },
  result: {
    backgroundColor: color.surfaceHigh,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: color.line,
    padding: space.md,
  },
  resultName: { color: color.ink, fontSize: 13 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  row: { flexDirection: 'row', gap: space.sm },
  locked: { gap: space.sm, backgroundColor: color.surfaceHigh },

  error: { color: color.danger, fontSize: 13 },
});
