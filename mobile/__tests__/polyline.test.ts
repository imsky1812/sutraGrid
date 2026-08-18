import { decodePolyline } from '../src/polyline';

describe('decodePolyline', () => {
  it('decodes the canonical Google example', () => {
    // Fixture from Google's encoded-polyline-algorithm documentation.
    const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(points).toHaveLength(3);
    expect(points[0].latitude).toBeCloseTo(38.5, 5);
    expect(points[0].longitude).toBeCloseTo(-120.2, 5);
    expect(points[1].latitude).toBeCloseTo(40.7, 5);
    expect(points[1].longitude).toBeCloseTo(-120.95, 5);
    expect(points[2].latitude).toBeCloseTo(43.252, 5);
    expect(points[2].longitude).toBeCloseTo(-126.453, 5);
  });

  it('returns an empty array for an empty string', () => {
    expect(decodePolyline('')).toEqual([]);
  });

  it('decodes a single point', () => {
    const points = decodePolyline('_p~iF~ps|U');
    expect(points).toHaveLength(1);
    expect(points[0].latitude).toBeCloseTo(38.5, 5);
    expect(points[0].longitude).toBeCloseTo(-120.2, 5);
  });

  // Deltas are stored relative to the previous point, so an off-by-one in the
  // accumulator shows up as drift rather than an obviously wrong first point.
  it('accumulates deltas so later points stay correct', () => {
    const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    const latDelta = points[1].latitude - points[0].latitude;
    expect(latDelta).toBeCloseTo(2.2, 5);
  });

  it('produces coordinates within valid geographic bounds', () => {
    for (const p of decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')) {
      expect(p.latitude).toBeGreaterThanOrEqual(-90);
      expect(p.latitude).toBeLessThanOrEqual(90);
      expect(p.longitude).toBeGreaterThanOrEqual(-180);
      expect(p.longitude).toBeLessThanOrEqual(180);
    }
  });
});
