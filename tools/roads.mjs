/**
 * Turning OpenStreetMap roads into the segments the wrong-way check reads.
 *
 * No network and no Supabase client here, so it can be tested directly. The
 * one rule that matters most: a segment always runs from a to b in the
 * direction traffic is allowed, which means a road tagged oneway=-1 has to be
 * flipped. Get that backwards and every lawful driver on it is flagged.
 */

/** Roads a car can be on. Footways, cycleways and paths are left out. */
export const DRIVABLE = [
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
  'tertiary', 'tertiary_link',
  'unclassified', 'residential', 'living_street', 'service',
];

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG = 111320;

/** A box around a point, as Overpass wants it: south, west, north, east. */
export function bboxAround(lat, lng, radiusM) {
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLng = radiusM / (M_PER_DEG_LNG * Math.cos((lat * Math.PI) / 180));
  return [lat - dLat, lng - dLng, lat + dLat, lng + dLng].map((v) => Number(v.toFixed(6)));
}

export function overpassQuery([south, west, north, east]) {
  return (
    `[out:json][timeout:90];` +
    `way["highway"~"^(${DRIVABLE.join('|')})$"](${south},${west},${north},${east});` +
    `out geom tags;`
  );
}

/**
 * Which way traffic may go. OpenStreetMap says it several ways: oneway=yes,
 * oneway=-1 (one-way against the order the nodes were drawn in), and
 * motorways and roundabouts are one-way unless tagged otherwise.
 */
export function onewayOf(tags = {}) {
  const v = String(tags.oneway ?? '').toLowerCase();
  if (v === '-1' || v === 'reverse') return 'reverse';
  if (v === 'yes' || v === 'true' || v === '1') return 'forward';
  if (v === 'no' || v === 'false' || v === '0') return 'none';
  // Some roads are one-way only at certain times. Treating them as one-way
  // all day would flag people driving them lawfully.
  if (v === 'alternating' || v === 'reversible') return 'none';
  if (tags.junction === 'roundabout' || tags.junction === 'circular') return 'forward';
  if (tags.highway === 'motorway' || tags.highway === 'motorway_link') return 'forward';
  return 'none';
}

/** "50", "50 km/h", "30 mph" in km/h; anything else (e.g. "IN:urban") is unknown. */
export function maxspeedOf(raw) {
  if (raw === undefined || raw === null) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?\s*$/i.exec(String(raw));
  if (!m) return null;
  const n = Number(m[1]) * (m[2] && /mph/i.test(m[2]) ? 1.609344 : 1);
  return n > 0 && n <= 200 ? Math.round(n) : null;
}

/**
 * One row per pair of consecutive nodes. Ways without geometry, or with fewer
 * than two nodes, are skipped rather than guessed at.
 */
export function segmentsFromWays(elements) {
  const rows = [];
  for (const way of elements ?? []) {
    if (way?.type !== 'way' || !Array.isArray(way.geometry) || way.geometry.length < 2) continue;
    const tags = way.tags ?? {};
    const direction = onewayOf(tags);
    const points =
      direction === 'reverse' ? [...way.geometry].reverse() : way.geometry;
    const name = (tags.name ?? tags['name:en'] ?? tags.ref ?? null)?.slice(0, 200) ?? null;
    const maxspeed = maxspeedOf(tags.maxspeed);

    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (![a?.lat, a?.lon, b?.lat, b?.lon].every(Number.isFinite)) continue;
      if (a.lat === b.lat && a.lon === b.lon) continue;
      rows.push({
        osm_way_id: way.id,
        name,
        highway: tags.highway ?? null,
        a_lat: a.lat,
        a_lng: a.lon,
        b_lat: b.lat,
        b_lng: b.lon,
        oneway: direction !== 'none',
        maxspeed_kmh: maxspeed,
      });
    }
  }
  return rows;
}

/**
 * Split a box into tiles no bigger than `maxSpanDeg` on a side. A public
 * Overpass server refuses or times out a big query long before it struggles
 * with several small ones, so a 6 km area is fetched as a handful of tiles.
 */
export function tiles([south, west, north, east], maxSpanDeg = 0.015) {
  const rows = Math.max(1, Math.ceil((north - south) / maxSpanDeg));
  const cols = Math.max(1, Math.ceil((east - west) / maxSpanDeg));
  const dLat = (north - south) / rows;
  const dLng = (east - west) / cols;
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push([
        south + r * dLat,
        west + c * dLng,
        south + (r + 1) * dLat,
        west + (c + 1) * dLng,
      ].map((v) => Number(v.toFixed(6))));
    }
  }
  return out;
}

/** A road crossing a tile edge comes back from both tiles; keep it once. */
export function uniqueWays(elements) {
  const seen = new Map();
  for (const e of elements) if (e?.type === 'way' && !seen.has(e.id)) seen.set(e.id, e);
  return [...seen.values()];
}

/** Split into batches so one insert does not exceed request limits. */
export function batches(rows, size = 500) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
