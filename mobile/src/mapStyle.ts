/**
 * Map tiles.
 *
 * OpenFreeMap serves OpenStreetMap-derived vector tiles with no API key, no
 * account and no usage quota. That removes the whole key-management surface
 * from the map: nothing to restrict, nothing to rotate, nothing to leak.
 *
 * Their `dark` style is close to the app canvas already. Point this at a
 * self-hosted style JSON if the map ever needs to match the palette exactly.
 */
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';

/** Lime, matching color.accent. The route is the only saturated thing drawn. */
export const ROUTE_COLOR = '#D7F94A';
export const ROUTE_WIDTH = 5;

/** Attribution is required by the ODbL licence covering OpenStreetMap data. */
export const MAP_ATTRIBUTION = '© OpenStreetMap contributors';
