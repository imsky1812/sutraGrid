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
import {
  cadenceFor,
  setAlertMessage,
  setDestination,
  startTelemetry,
  stopTelemetry,
} from '../src/telemetry';
import { fetchRoute } from '../src/directions';
import {
  describePoint,
  findNearestServices,
  NearestPlace,
  Place,
  searchPlaces,
  ServiceKind,
} from '../src/places';
import {
  acknowledgeAlert,
  Alert as FleetAlert,
  CATEGORY_GLYPH,
  fetchActiveAlerts,
  subscribeToAlerts,
} from '../src/alerts';
import { announceAlert, prepareAlertSound } from '../src/alertSound';
import { registerForPush } from '../src/push';
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
import { describeNeighbour, EMERGENCY_COLOR, Radar } from '../src/Radar';
import {
  RADIUS_M,
  reckon,
  TrackedNeighbour,
  watchSurroundings,
} from '../src/surroundings';
import { headingFrom, type Point } from '../src/geo';
import { AccentAction, Badge, Card, Chip, Field, Label, NavBar, PillButton } from '../src/ui';
import { color, radius, shadow, space, type } from '../src/theme';
import type { LatLng } from '../src/polyline';

/** Only where the map looks before the first GPS fix. Never a routing origin. */
const BANGALORE = { latitude: 12.9716, longitude: 77.5946 };

/**
 * The emergency chips. These were three fixed Bengaluru coordinates with
 * invented names, so tapping "police" in Delhi drew a 2,000 km route south.
 * They are now looked up against the driver's own position.
 */
const SERVICES: { key: ServiceKind; glyph: string; label: string }[] = [
  { key: 'hospital', glyph: '🏥', label: 'Nearest hospital' },
  { key: 'fire', glyph: '🚒', label: 'Nearest fire station' },
  { key: 'police', glyph: '🚓', label: 'Nearest police' },
];

const NAV_ITEMS = [
  { key: 'route', glyph: '◎', label: 'Route' },
  { key: 'manual', glyph: '⌖', label: 'Manual coordinates' },
  { key: 'alert', glyph: '✦', label: 'Green corridor' },
  { key: 'around', glyph: '◉', label: 'Around me' },
];

/** How often the radar redraws between position updates, in ms. */
const RADAR_FRAME_MS = 60;

export default function Dashboard() {
  const { vehicleId } = useLocalSearchParams<{ vehicleId: string }>();

  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [loading, setLoading] = useState(true);
  const [route, setRoute] = useState<LatLng[]>([]);
  const [destLat, setDestLat] = useState('');
  const [destLng, setDestLng] = useState('');
  const [destName, setDestName] = useState('');
  const [activePreset, setActivePreset] = useState<string | null>(null);
  // The nearest hospital, fire station and police station, once looked up.
  // Cached for the session: they do not move, and the driver does not move far
  // enough between taps for it to matter.
  const [services, setServices] = useState<Partial<Record<ServiceKind, NearestPlace>>>({});
  const [findingService, setFindingService] = useState<ServiceKind | null>(null);
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
  // Live surroundings. `heading` is derived rather than read straight from the
  // sensor, which reports 0 whenever the phone is still.
  const [neighbours, setNeighbours] = useState<TrackedNeighbour[]>([]);
  const [myHeading, setMyHeading] = useState(0);
  const [radarMode, setRadarMode] = useState<'radar' | 'map'>('radar');
  const [frame, setFrame] = useState(() => Date.now());
  const lastFix = useRef<Point | null>(null);
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
        // So an alert still reaches this phone once the app is closed. Not
        // awaited: it is a network round trip the shift should not wait on,
        // and it reports its own failures.
        void registerForPush(found.id);
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
        lastFix.current = [first.coords.latitude, first.coords.longitude];
        setHere({ latitude: first.coords.latitude, longitude: first.coords.longitude });

        const sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, timeInterval: 4000, distanceInterval: 10 },
          (loc) => {
            if (!active) return;
            const point: Point = [loc.coords.latitude, loc.coords.longitude];
            // The radar rotates to this, so a wrong value spins the whole view.
            setMyHeading((last) =>
              headingFrom(
                loc.coords.heading,
                Math.max(0, (loc.coords.speed ?? 0) * 3.6),
                lastFix.current,
                point,
                last,
              ),
            );
            lastFix.current = point;
            setHere({ latitude: point[0], longitude: point[1] });
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

  // Poll the vehicles around this one, but only while the driver is looking at
  // them. It is a request every second or two, and nothing else on the screen
  // uses the answer.
  useEffect(() => {
    if (pane !== 'around' || !vehicle) return;

    const stop = watchSurroundings(
      vehicle.id,
      cadenceFor(vehicle.is_emergency_authorized),
      setNeighbours,
      // A dropped request on a moving phone is ordinary, and the loop keeps
      // going, so this must not clear the screen or shout.
      (message) => setLocationError(message),
    );
    return () => {
      stop();
      setNeighbours([]);
    };
  }, [pane, vehicle]);

  // The clock the radar is drawn against. Positions arrive every one to three
  // seconds; this is what carries the icons smoothly in between.
  useEffect(() => {
    if (pane !== 'around' || radarMode !== 'radar') return;
    const timer = setInterval(() => setFrame(Date.now()), RADAR_FRAME_MS);
    return () => clearInterval(timer);
  }, [pane, radarMode]);

  const applyDestination = useCallback(
    async (target: { latitude: number; longitude: number; name: string }, presetKey?: string) => {
      setError(null);
      setRouting(true);
      setActivePreset(presetKey ?? null);
      setDestination(target);
      setDestLat(String(target.latitude));
      setDestLng(String(target.longitude));
      setDestName(target.name);

      // No fallback origin. Routing from a guessed city centre is how a
      // destination two thousand kilometres away looked like a working route.
      if (!here) {
        setRoute([]);
        setRouting(false);
        return setError('Waiting for your location before planning a route.');
      }

      try {
        setRoute(await fetchRoute(here, target));
      } catch (e) {
        setRoute([]);
        setError((e as Error).message);
      } finally {
        setRouting(false);
      }
    },
    [here],
  );

  /** Route to the nearest hospital, fire station or police station. */
  async function goToNearest(kind: ServiceKind) {
    setError(null);
    if (!here) return setError('Waiting for your location before finding the nearest one.');

    const known = services[kind];
    if (known) return applyDestination(known, kind);

    setFindingService(kind);
    try {
      const found = await findNearestServices(kind, here);
      if (found.length === 0) {
        return setError('Nothing of that kind is mapped near you. Try searching by name.');
      }
      setServices((current) => ({ ...current, [kind]: found[0] }));
      await applyDestination(found[0], kind);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFindingService(null);
    }
  }

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
    if (!here) return setError('Waiting for your location before opening a corridor.');

    setCorridorBusy(true);
    try {
      const destination = { latitude: Number(destLat), longitude: Number(destLng) };
      const plan = await planCorridor(here, destination);
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

        {pane === 'around' && radarMode === 'map'
          ? neighbours.map((n) => {
              const [lat, lng] = reckon(n, frame);
              return (
                <Marker key={n.ref} id={`near-${n.ref}`} lngLat={[lng, lat]}>
                  <View
                    testID={`map-vehicle-${n.ref}`}
                    style={[
                      styles.nearDot,
                      n.is_emergency && { backgroundColor: EMERGENCY_COLOR },
                      n.warned && styles.nearWarned,
                      { transform: [{ rotate: `${n.heading}deg` }] },
                    ]}
                  />
                </Marker>
              );
            })
          : null}

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

              <Label>Emergency services near you</Label>
              <View style={styles.chipRow}>
                {SERVICES.map((s) => {
                  const found = services[s.key];
                  return (
                    <Chip
                      key={s.key}
                      glyph={s.glyph}
                      label={
                        findingService === s.key
                          ? 'Finding…'
                          : found
                            ? `${found.name.split(',')[0]} · ${formatDistance(found.distanceMeters)}`
                            : s.label
                      }
                      selected={activePreset === s.key}
                      disabled={!here || findingService !== null}
                      onPress={() => goToNearest(s.key)}
                    />
                  );
                })}
              </View>
              {here ? null : (
                <Text style={type.muted}>Waiting for your location to find these.</Text>
              )}

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

          {pane === 'around' ? (
            <View style={styles.pane}>
              <View style={styles.row}>
                <Chip
                  glyph="◉"
                  label="Radar"
                  selected={radarMode === 'radar'}
                  onPress={() => setRadarMode('radar')}
                />
                <Chip
                  glyph="⌗"
                  label="Map"
                  selected={radarMode === 'map'}
                  onPress={() => setRadarMode('map')}
                />
              </View>

              {radarMode === 'radar' ? (
                <Radar
                  here={here ? [here.latitude, here.longitude] : null}
                  heading={myHeading}
                  neighbours={neighbours}
                  rangeM={RADIUS_M}
                  now={frame}
                  size={240}
                />
              ) : (
                <Text style={type.muted}>
                  {neighbours.length > 0
                    ? 'Shown on the map behind this panel, pointing the way they are facing.'
                    : 'Nothing to show on the map yet.'}
                </Text>
              )}

              {here
                ? neighbours
                    .slice(0, 4)
                    .map((n) => (
                      <View key={n.ref} style={styles.result}>
                        <Text style={styles.resultName}>
                          {n.is_emergency ? `${n.vehicle_type} · ` : ''}
                          {describeNeighbour([here.latitude, here.longitude], myHeading, n, frame)}
                          {n.warned ? ' · giving way' : ''}
                        </Text>
                      </View>
                    ))
                : null}

              {/* The same honesty the corridor's SIM badge carries. A jury will
                  ask what this can and cannot see, and the answer belongs on
                  the screen rather than in a pitch deck. */}
              <Text style={type.muted}>
                Only vehicles running SUTRA appear here. Other traffic, pedestrians and
                lane positions need sensors on the vehicle, which a phone does not have.
                An empty view means nobody nearby is sharing, not that the road is clear.
              </Text>
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
  nearDot: {
    width: 14,
    height: 14,
    borderRadius: 4,
    backgroundColor: color.muted,
    borderWidth: 1,
    borderColor: color.canvas,
  },
  nearWarned: { borderWidth: 2, borderColor: color.accent },
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
