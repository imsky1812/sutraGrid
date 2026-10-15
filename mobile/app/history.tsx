import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import {
  describeViolation,
  fetchTrips,
  fetchViolations,
  formatDuration,
  HISTORY_DAYS,
  summarize,
  Trip,
  Violation,
} from '../src/history';
import { Badge, Card, Label } from '../src/ui';
import { color, space, type } from '../src/theme';

/**
 * A driver's own last week: trips and the rules broken on them.
 *
 * Deliberately the driver's own record, read under the same row-level security
 * as everything else. If a traffic authority can see how someone drove, the
 * person who drove should be able to see it too.
 */
export default function History() {
  const { vehicleId, plate } = useLocalSearchParams<{ vehicleId: string; plate?: string }>();
  const insets = useSafeAreaInsets();

  const [trips, setTrips] = useState<Trip[]>([]);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, v] = await Promise.all([fetchTrips(vehicleId), fetchViolations(vehicleId)]);
      setTrips(t);
      setViolations(v);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [vehicleId]);

  useEffect(() => {
    load();
  }, [load]);

  const total = summarize(trips);

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <View style={[styles.header, { paddingTop: insets.top + space.lg }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/vehicle-setup'))}
          style={styles.back}
        >
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
        <View>
          <Text style={type.caption}>LAST {HISTORY_DAYS} DAYS</Text>
          <Text style={type.title}>{plate ?? 'Your history'}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={color.accent} />}
      >
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.summaryRow}>
          <Summary value={total.km.toFixed(1)} label="km driven" />
          <Summary value={formatDuration(total.minutes)} label="driving" />
          <Summary value={total.topSpeed.toFixed(0)} label="top km/h" />
          <Summary
            value={String(violations.length)}
            label="rule breaks"
            warn={violations.length > 0}
          />
        </View>

        <Label>Trips</Label>
        {!loading && trips.length === 0 ? (
          <Text style={type.muted}>
            No trips in the last {HISTORY_DAYS} days. Time spent parked is not counted as driving.
          </Text>
        ) : null}
        {trips.map((trip) => {
          const started = new Date(trip.started_at);
          return (
            <Card key={`${trip.trip_no}-${trip.started_at}`} style={styles.row}>
              <View style={styles.rowTop}>
                <Text style={type.section}>
                  {started.toLocaleString([], {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Text>
                {trip.violations > 0 ? (
                  <Badge label={`${trip.violations} rule break${trip.violations === 1 ? '' : 's'}`} />
                ) : (
                  <Badge label="clean" live />
                )}
              </View>
              <Text style={type.muted}>
                {(Number(trip.distance_m) / 1000).toFixed(1)} km ·{' '}
                {formatDuration(
                  (new Date(trip.ended_at).getTime() - started.getTime()) / 60_000,
                )}{' '}
                · top {Math.round(trip.top_speed)} km/h
              </Text>
            </Card>
          );
        })}

        <Label>Rule breaks</Label>
        {!loading && violations.length === 0 ? (
          <Text style={type.muted}>None this week.</Text>
        ) : null}
        {violations.map((v) => {
          const d = describeViolation(v);
          return (
            <Card key={`${v.kind}-${v.occurred_at}`} style={styles.row}>
              <Text style={[type.section, styles.warn]}>{d.title}</Text>
              <Text style={type.muted}>{d.detail}</Text>
              <Text style={type.muted}>
                {new Date(v.occurred_at).toLocaleString([], {
                  weekday: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </Text>
            </Card>
          );
        })}
      </ScrollView>
    </View>
  );
}

function Summary({ value, label, warn }: { value: string; label: string; warn?: boolean }) {
  return (
    <View style={styles.summary}>
      <Text style={[styles.summaryValue, warn && styles.warn]}>{value}</Text>
      <Text style={type.caption}>{label.toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.canvas },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingBottom: space.md,
  },
  back: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceHigh,
  },
  backGlyph: { color: color.ink, fontSize: 26, lineHeight: 28 },
  content: { paddingHorizontal: space.xl, gap: space.md },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  summary: {
    flexGrow: 1,
    flexBasis: '45%',
    backgroundColor: color.surfaceHigh,
    borderRadius: 14,
    padding: space.md,
    gap: 2,
  },
  summaryValue: { color: color.ink, fontSize: 22, fontWeight: '800' },
  row: { gap: 4 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm },
  warn: { color: color.danger },
  error: { color: color.danger },
});
