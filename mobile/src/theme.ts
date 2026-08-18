/**
 * Design tokens from the supplied reference: a near-black canvas with a faint
 * olive cast, and a single acid-lime accent.
 *
 * The accent does one job — it marks the live thing. On the map that is the
 * route; in the nav it is where you are; on a card it is the way forward.
 * Spending it anywhere else would flatten that signal, so nothing decorative
 * uses lime.
 */

export const color = {
  /** Near-black with a green cast, so lime reads as belonging to it. */
  canvas: '#0D0F0B',
  /** Raised surfaces: cards, the sheet, the nav bar. */
  surface: '#181B15',
  surfaceHigh: '#22261E',
  /** Hairlines at low contrast; the design separates by elevation, not rules. */
  line: '#2A2F24',

  accent: '#D7F94A',
  accentDim: '#A8C43A',
  /** Translucent lime for pressed states and quiet fills. */
  accentGhost: 'rgba(215, 249, 74, 0.14)',

  ink: '#FFFFFF',
  muted: '#9CA096',
  faint: '#6B6F65',

  /** On lime, text and glyphs go dark — never white. */
  onAccent: '#0D0F0B',

  danger: '#FF6B5A',
  success: '#8FE388',
} as const;

export const radius = {
  chip: 14,
  input: 16,
  card: 22,
  sheet: 28,
  pill: 999,
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const type = {
  /** Headlines are tight and heavy; the reference pairs them with an italic. */
  display: { fontSize: 30, fontWeight: '800', letterSpacing: -0.9, color: color.ink, lineHeight: 36 },
  displayAccent: {
    fontSize: 30,
    fontWeight: '600',
    fontStyle: 'italic',
    letterSpacing: -0.9,
    color: color.ink,
    lineHeight: 36,
  },
  title: { fontSize: 19, fontWeight: '700', letterSpacing: -0.3, color: color.ink },
  section: { fontSize: 15, fontWeight: '700', letterSpacing: -0.2, color: color.ink },
  body: { fontSize: 14, fontWeight: '400', color: color.ink },
  muted: { fontSize: 13, fontWeight: '400', color: color.muted, lineHeight: 20 },
  caption: { fontSize: 10, fontWeight: '700', letterSpacing: 1.1, color: color.muted },
  button: { fontSize: 15, fontWeight: '700', letterSpacing: -0.1 },
} as const;

/**
 * On a dark canvas a drop shadow is nearly invisible, so elevation is carried
 * by surface lightness. These stay subtle and exist mainly for Android.
 */
export const shadow = {
  card: {
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  float: {
    shadowColor: '#000',
    shadowOpacity: 0.55,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
} as const;
