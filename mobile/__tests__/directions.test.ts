const mockInvoke = jest.fn();

jest.mock('../src/supabase', () => ({
  supabase: { functions: { invoke: (...a: unknown[]) => mockInvoke(...a) } },
}));

import { fetchRoute } from '../src/directions';

const ORIGIN = { latitude: 38.5, longitude: -120.2 };
const DEST = { latitude: 43.252, longitude: -126.453 };

describe('fetchRoute', () => {
  beforeEach(() => jest.clearAllMocks());

  it('decodes the polyline returned by the Edge Function', async () => {
    mockInvoke.mockResolvedValue({ data: { polyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }, error: null });

    const points = await fetchRoute(ORIGIN, DEST);
    expect(points).toHaveLength(3);
    expect(points[0].latitude).toBeCloseTo(38.5, 5);
  });

  it('calls the directions function with origin and destination', async () => {
    mockInvoke.mockResolvedValue({ data: { polyline: '_p~iF~ps|U' }, error: null });

    await fetchRoute(ORIGIN, DEST);

    expect(mockInvoke).toHaveBeenCalledWith('directions', {
      body: { origin: ORIGIN, destination: DEST },
    });
  });

  it('throws with the function error message', async () => {
    mockInvoke.mockResolvedValue({ data: null, error: { message: 'Directions failed: ZERO_RESULTS' } });

    await expect(fetchRoute(ORIGIN, DEST)).rejects.toThrow(/ZERO_RESULTS/);
  });

  it('throws when the response carries no polyline', async () => {
    mockInvoke.mockResolvedValue({ data: {}, error: null });

    await expect(fetchRoute(ORIGIN, DEST)).rejects.toThrow(/no route/i);
  });

  it('throws when the function returns nothing at all', async () => {
    mockInvoke.mockResolvedValue({ data: null, error: null });

    await expect(fetchRoute(ORIGIN, DEST)).rejects.toThrow(/no route/i);
  });
});
