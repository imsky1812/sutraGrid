import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from 'react-native';
import { color, radius, shadow, space, type } from './theme';

/** Raised dark surface. Elevation is carried by lightness, not shadow. */
export function Card({
  children,
  style,
  onPress,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  onPress?: () => void;
}) {
  if (!onPress) return <View style={[styles.card, style]}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, style, pressed && styles.cardPressed]}
    >
      {children}
    </Pressable>
  );
}

type PillProps = {
  label: string;
  onPress?: () => void;
  variant?: 'accent' | 'surface' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  /** Leading glyph, as the reference sets on its primary call to action. */
  glyph?: string;
};

export function PillButton({
  label,
  onPress,
  variant = 'accent',
  disabled,
  busy,
  glyph,
}: PillProps) {
  const onLime = variant === 'accent';
  const fg = onLime ? color.onAccent : color.ink;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.pill,
        onLime && styles.pillAccent,
        variant === 'surface' && styles.pillSurface,
        variant === 'danger' && styles.pillDanger,
        (disabled || busy) && styles.pillDisabled,
        pressed && styles.pillPressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.pillRow}>
          {glyph ? <Text style={[styles.pillGlyph, { color: fg }]}>{glyph}</Text> : null}
          <Text style={[type.button, { color: fg }]} numberOfLines={1}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/** Small lime circle with a dark glyph — the reference's card affordance. */
export function AccentAction({
  glyph = '↗',
  label,
  onPress,
}: {
  glyph?: string;
  label: string;
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.accentAction, pressed && { opacity: 0.85 }]}
    >
      <Text style={styles.accentActionGlyph}>{glyph}</Text>
    </Pressable>
  );
}

/** Dark pill with a lime dot and an uppercase label. */
export function Badge({ label, live }: { label: string; live?: boolean }) {
  return (
    <View style={styles.badge}>
      {live ? <View style={styles.badgeDot} /> : null}
      <Text style={styles.badgeText}>{label.toUpperCase()}</Text>
    </View>
  );
}

/** Rounded selector; selected state fills lime. */
export function Chip({
  glyph,
  label,
  selected,
  onPress,
}: {
  glyph?: string;
  label: string;
  selected?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      {glyph ? <Text style={styles.chipGlyph}>{glyph}</Text> : null}
      <Text
        style={[styles.chipLabel, selected && { color: color.onAccent }]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Floating dark bar with circular items; the active one fills lime. */
export function NavBar({
  items,
  activeKey,
  onSelect,
}: {
  items: { key: string; glyph: string; label: string }[];
  activeKey: string;
  onSelect: (key: string) => void;
}) {
  return (
    <View style={styles.nav}>
      {items.map((item) => {
        const active = item.key === activeKey;
        return (
          <Pressable
            key={item.key}
            accessibilityRole="tab"
            accessibilityLabel={item.label}
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(item.key)}
            style={[styles.navItem, active && styles.navItemActive]}
          >
            <Text style={[styles.navGlyph, active && { color: color.onAccent }]}>
              {item.glyph}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Field(props: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={color.faint}
      {...props}
      style={[styles.field, props.style]}
    />
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return <Text style={type.caption}>{String(children).toUpperCase()}</Text>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.line,
    padding: space.lg,
    ...shadow.card,
  },
  cardPressed: { backgroundColor: color.surfaceHigh },

  pill: {
    borderRadius: radius.pill,
    paddingVertical: 16,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 54,
  },
  pillRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  pillGlyph: { fontSize: 15 },
  pillAccent: { backgroundColor: color.accent },
  pillSurface: { backgroundColor: color.surfaceHigh, borderWidth: 1, borderColor: color.line },
  pillDanger: { backgroundColor: color.danger },
  pillDisabled: { opacity: 0.45 },
  pillPressed: { opacity: 0.85 },

  accentAction: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  accentActionGlyph: { color: color.onAccent, fontSize: 17, fontWeight: '700' },

  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: color.canvas,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: color.line,
  },
  badgeDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.accent },
  badgeText: { color: color.ink, fontSize: 9.5, fontWeight: '700', letterSpacing: 1 },

  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: color.surfaceHigh,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: color.line,
    paddingVertical: 9,
    paddingHorizontal: 14,
  },
  chipSelected: { backgroundColor: color.accent, borderColor: color.accent },
  chipGlyph: { fontSize: 13 },
  chipLabel: { fontSize: 12, fontWeight: '700', color: color.muted },

  nav: {
    flexDirection: 'row',
    alignSelf: 'center',
    gap: space.sm,
    backgroundColor: color.surface,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.line,
    padding: 7,
    ...shadow.float,
  },
  navItem: {
    width: 46,
    height: 46,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navItemActive: { backgroundColor: color.accent },
  navGlyph: { fontSize: 17, color: color.muted },

  field: {
    backgroundColor: color.surface,
    borderRadius: radius.input,
    borderWidth: 1,
    borderColor: color.line,
    paddingHorizontal: space.lg,
    paddingVertical: 15,
    fontSize: 15,
    color: color.ink,
  },
});
