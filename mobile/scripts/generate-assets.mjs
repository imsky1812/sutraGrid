/**
 * Generates the app icon, adaptive icon layers, splash mark and favicon.
 *
 * These are drawn in code rather than dropped in as binaries so the brand mark
 * stays editable and reviewable in the repo. Run with:
 *
 *   node scripts/generate-assets.mjs
 *
 * The mark is a route: an origin node, a path, and a destination ring. That is
 * the one thing this app is about, and it reads at 48px as well as at 1024.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', 'assets');

const CANVAS = [0x0d, 0x0f, 0x0b]; // color.canvas
const LIME = [0xd7, 0xf9, 0x4a]; // color.accent
const WHITE = [0xff, 0xff, 0xff];

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // One filter byte (0 = none) per scanline.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function surface(size, background) {
  const buf = Buffer.alloc(size * size * 4, 0);
  if (background) {
    for (let i = 0; i < size * size; i++) {
      buf[i * 4] = background[0];
      buf[i * 4 + 1] = background[1];
      buf[i * 4 + 2] = background[2];
      buf[i * 4 + 3] = 255;
    }
  }
  return buf;
}

/** Source-over blend of one pixel at the given coverage. */
function blend(buf, size, x, y, rgb, coverage) {
  if (coverage <= 0 || x < 0 || y < 0 || x >= size || y >= size) return;
  const a = Math.min(1, coverage);
  const i = (y * size + x) * 4;
  const dstA = buf[i + 3] / 255;
  const outA = a + dstA * (1 - a);
  for (let c = 0; c < 3; c++) {
    const src = rgb[c] / 255;
    const dst = buf[i + c] / 255;
    buf[i + c] = Math.round(((src * a + dst * dstA * (1 - a)) / (outA || 1)) * 255);
  }
  buf[i + 3] = Math.round(outA * 255);
}

/** Signed distance from a point to a line segment. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Rasterise a shape from its distance field, feathering one pixel for a clean
 * edge. Every mark below is expressed as a distance function so anti-aliasing
 * comes for free.
 */
function paint(buf, size, rgb, sdf) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = sdf(x + 0.5, y + 0.5);
      if (d > 1) continue;
      blend(buf, size, x, y, rgb, Math.min(1, 1 - d));
    }
  }
}

function strokePath(buf, size, rgb, points, width) {
  const half = width / 2;
  paint(buf, size, rgb, (x, y) => {
    let best = Infinity;
    for (let i = 0; i < points.length - 1; i++) {
      const d = distanceToSegment(x, y, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]);
      if (d < best) best = d;
    }
    return best - half;
  });
}

function fillCircle(buf, size, rgb, cx, cy, r) {
  paint(buf, size, rgb, (x, y) => Math.hypot(x - cx, y - cy) - r);
}

function strokeCircle(buf, size, rgb, cx, cy, r, width) {
  const half = width / 2;
  paint(buf, size, rgb, (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r) - half);
}

/** Move `from` toward `to` by `amount`, used to stop a path short of a node. */
function trimToward([fx, fy], [tx, ty], amount) {
  const len = Math.hypot(tx - fx, ty - fy);
  if (len === 0 || amount >= len) return [fx, fy];
  const t = amount / len;
  return [fx + (tx - fx) * t, fy + (ty - fy) * t];
}

// ---------------------------------------------------------------------------
// The mark
// ---------------------------------------------------------------------------

// Normalised route: origin, two bends, destination.
const ROUTE = [
  [0.24, 0.78],
  [0.40, 0.55],
  [0.60, 0.63],
  [0.75, 0.27],
];

/**
 * Draw the route mark into `buf`.
 * `scale` shrinks it toward the centre for adaptive-icon safe zones.
 */
function drawMark(buf, size, rgb, { scale = 1 } = {}) {
  const map = ([nx, ny]) => [
    (0.5 + (nx - 0.5) * scale) * size,
    (0.5 + (ny - 0.5) * scale) * size,
  ];

  const pts = ROUTE.map(map);
  const stroke = size * 0.058 * scale;
  const ringRadius = size * 0.088 * scale;
  const ringWidth = size * 0.042 * scale;

  // Stop the path at the ring's outer edge. Drawing it to the ring's centre
  // makes the line appear to pass straight through the destination.
  const trimmed = [...pts];
  trimmed[trimmed.length - 1] = trimToward(
    pts[pts.length - 1],
    pts[pts.length - 2],
    ringRadius + ringWidth / 2,
  );

  strokePath(buf, size, rgb, trimmed, stroke);

  // Origin: solid node. Destination: ring. The two ends read differently at a
  // glance, which is the whole job of the mark.
  fillCircle(buf, size, rgb, pts[0][0], pts[0][1], size * 0.055 * scale);
  strokeCircle(
    buf,
    size,
    rgb,
    pts[pts.length - 1][0],
    pts[pts.length - 1][1],
    ringRadius,
    ringWidth,
  );
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

function write(name, buffer) {
  writeFileSync(join(ASSETS, name), buffer);
  console.log(`  ${name}  ${(buffer.length / 1024).toFixed(1)} KB`);
}

mkdirSync(ASSETS, { recursive: true });
console.log('Generating assets:');

const SIZE = 1024;

// App icon: full-bleed dark tile with the lime route.
{
  const buf = surface(SIZE, CANVAS);
  drawMark(buf, SIZE, LIME);
  write('icon.png', encodePng(SIZE, SIZE, buf));
}

// Adaptive background: flat canvas colour.
{
  const buf = surface(SIZE, CANVAS);
  write('android-icon-background.png', encodePng(SIZE, SIZE, buf));
}

// Adaptive foreground: mark only, inset into the safe zone. Android crops the
// outer third for some mask shapes, so the mark is scaled to survive it.
{
  const buf = surface(SIZE, null);
  drawMark(buf, SIZE, LIME, { scale: 0.62 });
  write('android-icon-foreground.png', encodePng(SIZE, SIZE, buf));
}

// Monochrome layer for themed icons: same mark, flat white.
{
  const buf = surface(SIZE, null);
  drawMark(buf, SIZE, WHITE, { scale: 0.62 });
  write('android-icon-monochrome.png', encodePng(SIZE, SIZE, buf));
}

// Splash mark: transparent, sits on the configured splash background.
{
  const buf = surface(SIZE, null);
  drawMark(buf, SIZE, LIME, { scale: 0.72 });
  write('splash-icon.png', encodePng(SIZE, SIZE, buf));
}

// Favicon for the web target.
{
  const small = 64;
  const buf = surface(small, CANVAS);
  drawMark(buf, small, LIME, { scale: 0.92 });
  write('favicon.png', encodePng(small, small, buf));
}

console.log('Done.');
