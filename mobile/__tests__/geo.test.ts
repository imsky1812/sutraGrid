// The geometry the radar is built on.
//
// Everything here must agree with the database's approx_distance_m, because a
// distance that means one thing on the phone and another in a trigger is how a
// warning fires at the wrong moment.

import { bearing, distanceM, headingFrom, normalizeDeg, project, toRelative } from '../src/geo';

const DELHI: [number, number] = [28.6139, 77.209];

test('one degree of latitude is the constant the database uses', () => {
  expect(Math.round(distanceM([0, 0], [1, 0]))).toBe(110540);
});

test('longitude narrows with latitude', () => {
  const atEquator = distanceM([0, 0], [0, 1]);
  const atDelhi = distanceM([28.6, 0], [28.6, 1]);
  expect(atEquator).toBeGreaterThan(atDelhi);
  expect(atDelhi / atEquator).toBeCloseTo(Math.cos((28.6 * Math.PI) / 180), 3);
});

describe('bearing', () => {
  test('reads as a compass: north 0, east 90, south 180, west 270', () => {
    expect(bearing(DELHI, [DELHI[0] + 0.01, DELHI[1]])).toBeCloseTo(0, 1);
    expect(bearing(DELHI, [DELHI[0], DELHI[1] + 0.01])).toBeCloseTo(90, 1);
    expect(bearing(DELHI, [DELHI[0] - 0.01, DELHI[1]])).toBeCloseTo(180, 1);
    expect(bearing(DELHI, [DELHI[0], DELHI[1] - 0.01])).toBeCloseTo(270, 1);
  });

  test('is never negative, so 0 and 360 are the only wraparound', () => {
    const west = bearing(DELHI, [DELHI[0] + 0.001, DELHI[1] - 0.01]);
    expect(west).toBeGreaterThan(180);
    expect(west).toBeLessThan(360);
  });

  test('a point on top of another has no direction rather than a wrong one', () => {
    expect(bearing(DELHI, DELHI)).toBe(0);
  });
});

describe('project', () => {
  test('is the inverse of bearing and distance', () => {
    for (const deg of [0, 45, 90, 170, 269, 359]) {
      const there = project(DELHI, deg, 500);
      expect(distanceM(DELHI, there)).toBeCloseTo(500, 0);
      expect(bearing(DELHI, there)).toBeCloseTo(deg, 0);
    }
  });

  test('accepts an angle outside 0–360', () => {
    expect(project(DELHI, -90, 100)).toEqual(project(DELHI, 270, 100));
  });
});

describe('toRelative', () => {
  // The whole point of the radar: what the driver sees, not what a map shows.
  test('a vehicle due north is ahead of a driver heading north', () => {
    const r = toRelative(DELHI, 0, [DELHI[0] + 0.001, DELHI[1]]);
    expect(r.bearingDeg).toBeCloseTo(0, 1);
  });

  test('the same vehicle is behind a driver heading south', () => {
    const r = toRelative(DELHI, 180, [DELHI[0] + 0.001, DELHI[1]]);
    expect(r.bearingDeg).toBeCloseTo(180, 1);
  });

  test('and to the left of a driver heading east', () => {
    const r = toRelative(DELHI, 90, [DELHI[0] + 0.001, DELHI[1]]);
    expect(r.bearingDeg).toBeCloseTo(270, 1);
  });

  test('reports the distance as well', () => {
    const r = toRelative(DELHI, 0, project(DELHI, 45, 250));
    expect(r.distanceM).toBeCloseTo(250, 0);
  });
});

test('normalizeDeg folds any angle into a compass reading', () => {
  expect(normalizeDeg(-90)).toBe(270);
  expect(normalizeDeg(450)).toBe(90);
  expect(normalizeDeg(360)).toBe(0);
});

// A parked phone reports heading 0, which would point every stationary icon
// north. The previous fix is the better answer.
describe('headingFrom', () => {
  const north = project(DELHI, 0, 50);

  test('trusts the sensor once moving', () => {
    expect(headingFrom(137, 40, DELHI, north)).toBe(137);
  });

  test('falls back to the way it came when stopped', () => {
    expect(headingFrom(0, 0, DELHI, north)).toBeCloseTo(0, 0);
    expect(headingFrom(0, 0, north, DELHI)).toBeCloseTo(180, 0);
  });

  test('keeps the last known heading when it has barely moved', () => {
    const nudge = project(DELHI, 90, 1);
    expect(headingFrom(0, 0, DELHI, nudge, 212)).toBe(212);
  });

  test('ignores a missing sensor reading', () => {
    expect(headingFrom(null, 60, DELHI, north)).toBeCloseTo(0, 0);
  });
});
