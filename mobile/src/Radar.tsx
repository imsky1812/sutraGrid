import { StyleSheet, Text, View } from 'react-native';
import { toRelative, type Point } from './geo';
import { reckon, type TrackedNeighbour } from './surroundings';
import { color, radius as radii, type } from './theme';

/**
 * The driver's own view of the road: them in the middle pointing up, and the
 * SUTRA vehicles around them placed by how far away they are and how many
 * degrees off the nose.
 *
 * Deliberately not a map. A map answers "where am I"; this answers "what is
 * around me", which is the question while driving. It is also drawn from plain
 * views rather than a canvas library, so it needs no native module and stays
 * cheap to re-render twenty times a second.
 */

const RING_FRACTIONS = [0.33, 0.66, 1];
/** Emergency vehicles share the corridor green, which already means "give way". */
const EMERGENCY_COLOR = '#22C55E';

export type RadarProps = {
  here: Point | null;
  /** The driver's own compass heading; the view rotates so this points up. */
  heading: number;
  neighbours: TrackedNeighbour[];
  rangeM: number;
  /** Passed in so the caller owns the animation clock, and tests own time. */
  now: number;
  size: number;
};

export function Radar({ here, heading, neighbours, rangeM, now, size }: RadarProps) {
  const centre = size / 2;
  const usable = centre - 18;

  const placed = here
    ? neighbours
        .map((n) => {
          const { bearingDeg, distanceM } = toRelative(here, heading, reckon(n, now));
          // Something outside the range is still real; it is pinned to the rim
          // rather than dropped, so a driver sees it arrive.
          const r = Math.min(distanceM / rangeM, 1) * usable;
          const theta = (bearingDeg * Math.PI) / 180;
          return {
            n,
            distanceM,
            left: centre + r * Math.sin(theta),
            top: centre - r * Math.cos(theta),
          };
        })
        .sort((a, b) => b.distanceM - a.distanceM)
    : [];

  return (
    <View testID="radar" style={[styles.wrap, { width: size, height: size }]}>
      {RING_FRACTIONS.map((f) => (
        <View
          key={f}
          style={[
            styles.ring,
            {
              width: usable * 2 * f,
              height: usable * 2 * f,
              borderRadius: usable * f,
              left: centre - usable * f,
              top: centre - usable * f,
            },
          ]}
        />
      ))}

      <Text style={[styles.rangeLabel, { top: centre - usable - 6, left: centre + 6 }]}>
        {Math.round(rangeM)} m
      </Text>

      {placed.map(({ n, left, top }) => (
        <View
          key={n.ref}
          testID={`radar-vehicle-${n.ref}`}
          style={[
            styles.vehicle,
            { left: left - 7, top: top - 7 },
            n.is_emergency && styles.emergency,
            n.warned && styles.warned,
          ]}
        />
      ))}

      <View testID="radar-ego" style={[styles.ego, { left: centre - 9, top: centre - 11 }]} />

      {here && neighbours.length === 0 ? (
        <Text style={[styles.empty, { top: centre + usable * 0.45 }]}>
          No SUTRA vehicles nearby
        </Text>
      ) : null}
      {here ? null : (
        <Text style={[styles.empty, { top: centre - 8 }]}>Waiting for your location</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignSelf: 'center',
    backgroundColor: color.surfaceHigh,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: color.line,
    overflow: 'hidden',
  },
  ring: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: color.line,
  },
  rangeLabel: {
    position: 'absolute',
    ...type.muted,
    fontSize: 10,
  },
  // A wedge, so which way a vehicle faces is readable at a glance.
  ego: {
    position: 'absolute',
    width: 0,
    height: 0,
    borderLeftWidth: 9,
    borderRightWidth: 9,
    borderBottomWidth: 22,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: color.accent,
  },
  vehicle: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 4,
    backgroundColor: color.muted,
  },
  emergency: { backgroundColor: EMERGENCY_COLOR },
  warned: { borderWidth: 2, borderColor: color.accent },
  empty: {
    position: 'absolute',
    width: '100%',
    textAlign: 'center',
    ...type.muted,
    fontSize: 12,
  },
});

/** A plain-language line for the nearest thing, for the list beside the radar. */
export function describeNeighbour(
  here: Point,
  heading: number,
  neighbour: TrackedNeighbour,
  now: number,
): string {
  const { bearingDeg, distanceM } = toRelative(here, heading, reckon(neighbour, now));
  const side =
    bearingDeg < 30 || bearingDeg > 330
      ? 'ahead'
      : bearingDeg < 150
        ? 'to your right'
        : bearingDeg < 210
          ? 'behind'
          : 'to your left';
  const far = distanceM >= 1000 ? `${(distanceM / 1000).toFixed(1)} km` : `${Math.round(distanceM)} m`;
  return `${far} ${side} · ${Math.round(neighbour.speed)} km/h`;
}

export { EMERGENCY_COLOR };
