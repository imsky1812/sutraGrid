import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Location from 'expo-location';
import { Camera, GeoJSONSource, Layer, Map, Marker, UserLocation } from '@maplibre/maplibre-react-native';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { announceAlert, prepareAlertSound } from '../src/alertSound';
import {
  CORRIDOR_COLOR,
  CorridorPlan,
  CorridorSignal,
  endCorridor,
  fetchSignals,
  nextSignal,
  planCorridor,
  progressAlong,
  SIGNAL_COLOR,
  SIGNAL_LABEL,
  startCorridor,
  watchCorridor,
} from '../src/corridor';
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
  { key: 'alert', glyph: '✦', label: 'Green corridor' },
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
  // Green corridor, for emergency-authorized vehicles only.
  const [corridorId, setCorridorId] = useState<string | null>(null);
  const [corridorPlan, setCorridorPlan] = useState<CorridorPlan | null>(null);
  const [signals, setSignals] = useState<CorridorSignal[]>([]);
  const [corridorBusy, setCorridorBusy] = useState(false);
  // Read by unmount cleanup, which cannot see current state.
  const corridorRef = useRef<string | null>(null);
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
  const [locationError, setLocationError] = useState<string | null>(null);

  const sheetRef = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ['30%', '82%'], []);
  // The app draws edge to edge, under the status and navigation bars, so every
  // offset from a screen edge has to include them.
  const insets = useSafeAreaInsets();

  // Android no longer shrinks the window for the keyboard when drawing edge to
  // edge, so the sheet's fields sat underneath it. While typing, the sheet
  // opens to the top and drops its header and tabs, which puts the field near
  // the top of the screen: above the keyboard on any phone.
  const [typing, setTyping] = useState(false);
  const sheetIndex = useRef(0);
  const indexBeforeTyping = useRef(0);

  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => {
      indexBeforeTyping.current = sheetIndex.current;
      setTyping(true);
      sheetRef.current?.snapToIndex(1);
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      setTyping(false);
      sheetRef.current?.snapToIndex(indexBeforeTyping.current);
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

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
          // Only new alerts beep. Ones already in force at launch were
          // fetched above and are shown quietly.
          void announceAlert(alert);
          acknowledgeAlert(alert.id, found.id).catch(() => {});
        });

        // Before telemetry, so the notification prompt comes up while the
        // driver is still looking at the screen rather than mid-drive.
        await prepareAlertSound();
        await startTelemetry(found);
      } catch (e) {
        if (active) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    })();

    // Permission has to be granted before any position call, and this used to
    // run before startTelemetry requested it - so the watch was rejected and the
    // rejection swallowed, leaving the map stuck on the fallback city forever.
    let positionWatch: Location.LocationSubscription | null = null;

    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          if (active) setLocationError('Location permission denied, so the map cannot follow you.');
          return;
        }
        if (!active) return;

        // One immediate fix, because watchPositionAsync only reports on the
        // next update and the map would otherwise sit on the fallback until the
        // driver moved.
        const first = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (!active) return;
        setHere({ latitude: first.coords.latitude, longitude: first.coords.longitude });

        const sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, timeInterval: 4000, distanceInterval: 10 },
          (loc) => {
            if (active) {
              setHere({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
            }
          },
        );
        positionWatch = sub;
        if (!active) sub.remove();
      } catch (e) {
        // Reported rather than swallowed: silence here is what hid the bug.
        if (active) setLocationError((e as Error)?.message ?? 'Could not read your location.');
      }
    })();

    return () => {
      active = false;
      positionWatch?.remove();
      unsubscribeAlerts?.();
      // A corridor with nobody driving it would keep warning drivers about an
      // ambulance that is not coming.
      if (corridorRef.current) endCorridor(corridorRef.current).catch(() => {});
      // The foreground service must not outlive the screen that started it.
      stopTelemetry();
    };
  }, [vehicleId]);

  // Follow the live corridor: signal transitions, and the database ending it
  // on arrival.
  useEffect(() => {
    if (!corridorId) return;
    let active = true;
    fetchSignals(corridorId)
      .then((current) => {
        if (active) setSignals(current);
      })
      .catch(() => {});
    const unwatch = watchCorridor(
      corridorId,
      (changed) => {
        if (active) setSignals((current) => current.map((s) => (s.id === changed.id ? changed : s)));
      },
      () => {
        if (active) closeCorridor('Arrived. Green corridor closed.');
      },
    );
    return () => {
      active = false;
      unwatch();
    };
  }, [corridorId]);

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

  function closeCorridor(note?: string) {
    corridorRef.current = null;
    setCorridorId(null);
    setCorridorPlan(null);
    setSignals([]);
    setAlertMessage(null);
    if (note) setError(note);
  }

  async function openCorridor() {
    if (!vehicle || !hasDestination) return;
    setError(null);
    setCorridorBusy(true);
    try {
      const destination = { latitude: Number(destLat), longitude: Number(destLng) };
      const plan = await planCorridor(here ?? BANGALORE, destination);
      const id = await startCorridor(vehicle.id, destName || 'Destination', plan);
      corridorRef.current = id;
      setCorridorPlan(plan);
      setCorridorId(id);
      // Shown next to this vehicle on the operator's map.
      setAlertMessage(`Green corridor to ${destName || 'destination'}`);
      if (!plan.signalsAvailable) {
        setError('Junction lookup is unavailable right now. Drivers ahead are still being warned.');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCorridorBusy(false);
    }
  }

  async function stopCorridor() {
    if (!corridorId) return;
    setCorridorBusy(true);
    try {
      await endCorridor(corridorId);
      closeCorridor();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCorridorBusy(false);
    }
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
  const progress = corridorPlan && here ? progressAlong(corridorPlan.route, here) : 0;
  const upcoming = corridorId ? nextSignal(signals, progress) : null;

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
      >
        {/* trackUserLocation is handled natively, which keeps the camera on the
            driver without this component re-centring it on every state change.
            The native side also reports when a pan breaks the tracking. */}
        <Camera
          trackUserLocation={follow ? 'default' : undefined}
          onTrackUserLocationChange={(event: any) => {
            if (!event?.nativeEvent?.trackUserLocation) setFollow(false);
          }}
          zoom={15}
          center={
            follow
              ? undefined
              : here
                ? [here.longitude, here.latitude]
                : [BANGALORE.longitude, BANGALORE.latitude]
          }
        />
        <UserLocation animated />

        {/* The route is the only saturated thing on the map, by design.
            GeoJSON is lon,lat — the reverse of the order used elsewhere here. */}
        {/* A live corridor replaces the plain route: its geometry is the one the
            database is warning drivers along. */}
        {corridorPlan ? (
          <GeoJSONSource
            id="corridor"
            data={{
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: corridorPlan.route.map(([lat, lng]) => [lng, lat]),
              },
            }}
          >
            <Layer
              id="corridor-glow"
              type="line"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{ 'line-color': CORRIDOR_COLOR, 'line-width': ROUTE_WIDTH * 3, 'line-opacity': 0.25 }}
            />
            <Layer
              id="corridor-line"
              type="line"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{ 'line-color': CORRIDOR_COLOR, 'line-width': ROUTE_WIDTH }}
            />
          </GeoJSONSource>
        ) : null}

        {corridorId
          ? signals.map((signal) => (
              <Marker key={signal.id} id={`signal-${signal.id}`} lngLat={[signal.lng, signal.lat]}>
                <View style={[styles.signalDot, { backgroundColor: SIGNAL_COLOR[signal.state] }]} />
              </Marker>
            ))
          : null}

        {!corridorPlan && route.length > 1 && (
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

      {/* Alerts from traffic control, and the corridor strip when one is live. */}
      {(alerts.length > 0 || corridorId) && (
        <View style={[styles.alertStack, { top: insets.top + TOP_BAR_CLEARANCE }]}>
          {corridorId ? (
            <View style={styles.corridorStrip}>
              <View
                style={[
                  styles.signalLamp,
                  { backgroundColor: upcoming ? SIGNAL_COLOR[upcoming.signal.state] : CORRIDOR_COLOR },
                ]}
              />
              <View style={styles.flex}>
                <Text style={styles.corridorTitle}>Green corridor active</Text>
                <Text style={styles.alertText}>
                  {upcoming
                    ? `Next junction ${formatDistance(upcoming.distanceM)} · ${SIGNAL_LABEL[upcoming.signal.state]}`
                    : signals.length > 0
                      ? 'All junctions cleared'
                      : 'Warning drivers ahead of you'}
                </Text>
              </View>
              <Text style={styles.simulated}>SIM</Text>
            </View>
          ) : null}
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
      <View style={[styles.topBar, { top: insets.top + space.md }]}>
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
        topInset={insets.top}
        onChange={(index) => {
          sheetIndex.current = index;
        }}
        // Matches the window mode Expo sets. The default, adjustPan, would tell
        // the sheet the window pans, which it does not.
        android_keyboardInputMode="adjustResize"
        backgroundStyle={styles.sheetBg}
        handleIndicatorStyle={styles.sheetHandle}
      >
        <BottomSheetScrollView
          contentContainerStyle={[styles.sheet, { paddingBottom: insets.bottom + space.xxl }]}
          keyboardShouldPersistTaps="handled"
        >
          {typing ? null : (
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

          )}

          {typing ? null : <NavBar items={NAV_ITEMS} activeKey={pane} onSelect={setPane} />}

          {error ? <Text style={styles.error}>{error}</Text> : null}
          {locationError ? <Text style={styles.error}>{locationError}</Text> : null}

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
              {!vehicle.is_emergency_authorized ? (
                <Card style={styles.locked}>
                  <Text style={type.section}>Not authorized</Text>
                  <Text style={type.muted}>
                    Green corridors are limited to emergency vehicles an administrator has
                    authorized.
                  </Text>
                </Card>
              ) : corridorId ? (
                <>
                  <Label>Junctions on your route</Label>
                  {signals.length === 0 ? (
                    <Text style={type.muted}>No mapped signals on this route.</Text>
                  ) : (
                    signals.map((signal) => (
                      <View key={signal.id} style={styles.signalRow}>
                        <View style={[styles.signalDot, { backgroundColor: SIGNAL_COLOR[signal.state] }]} />
                        <Text style={styles.resultName}>Junction {signal.seq}</Text>
                        <Text style={[type.muted, styles.flex]}>
                          {formatDistance(Math.max(0, signal.along_m - progress))}
                        </Text>
                        <Text style={styles.resultName}>{SIGNAL_LABEL[signal.state]}</Text>
                      </View>
                    ))
                  )}
                  <Text style={type.muted}>
                    Drivers ahead of you on this route are alerted to give way. Signal states
                    are simulated: SUTRA does not control traffic lights.
                  </Text>
                  <PillButton
                    label="End green corridor"
                    variant="danger"
                    busy={corridorBusy}
                    onPress={stopCorridor}
                  />
                </>
              ) : (
                <>
                  <Label>Green corridor</Label>
                  <Text style={type.muted}>
                    {hasDestination
                      ? `Fastest route to ${destName || 'your destination'}. Drivers ahead are alerted to give way, and the junctions on the way are shown.`
                      : 'Set a destination in Route first.'}
                  </Text>
                  <PillButton
                    label="Start green corridor"
                    glyph="✦"
                    busy={corridorBusy}
                    onPress={hasDestination ? openCorridor : () => setPane('route')}
                  />
                </>
              )}
            </View>
          ) : null}
        </BottomSheetScrollView>
      </BottomSheet>
    </View>
  );
}

/** Height of the floating status bar plus a gap, below the status-bar inset. */
const TOP_BAR_CLEARANCE = 76;

function formatDistance(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.canvas },
  centre: { alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },

  topBar: {
    position: 'absolute',
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
  corridorStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: CORRIDOR_COLOR,
    padding: space.md,
    ...shadow.float,
  },
  corridorTitle: { ...type.caption, color: CORRIDOR_COLOR },
  signalLamp: { width: 22, height: 22, borderRadius: 11 },
  // Always on screen while a corridor runs: the signal states are simulated.
  simulated: { color: color.faint, fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  signalDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: color.canvas,
  },
  signalRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
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
  sheet: { padding: space.xl, gap: space.lg },
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
