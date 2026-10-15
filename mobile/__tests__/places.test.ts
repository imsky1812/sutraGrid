// Finding the nearest emergency service.
//
// The chips this serves were hardcoded Bengaluru coordinates, so a driver in
// Delhi who tapped "police" was routed 2,000 km. The cases that matter are the
// ones where a provider is unhelpful: the app must then say so, or try the
// other route to the data, never fall back to a guess.

const mockInvoke = jest.fn();

jest.mock('../src/supabase', () => ({
  supabase: { functions: { invoke: (...a: unknown[]) => mockInvoke(...a) } },
}));

import { findNearestFromDevice, findNearestServices } from '../src/places';

const DELHI = { latitude: 28.6139, longitude: 77.209 };

const place = (name: string, latitude: number, longitude: number, distanceMeters: number) => ({
  name,
  latitude,
  longitude,
  distanceMeters,
});

const overpassOk = (elements: unknown[]) =>
  jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ elements }),
  } as unknown as Response);

beforeEach(() => jest.clearAllMocks());

test('returns what the function found, without touching the network itself', async () => {
  const found = [place('AIIMS', 28.5672, 77.21, 5200)];
  mockInvoke.mockResolvedValue({ data: { places: found, source: 'overpass' }, error: null });
  const fetchImpl = jest.fn();

  await expect(findNearestServices('hospital', DELHI, fetchImpl as never)).resolves.toEqual(found);
  expect(mockInvoke).toHaveBeenCalledWith('nearby', { body: { kind: 'hospital', near: DELHI } });
  expect(fetchImpl).not.toHaveBeenCalled();
});

// Measured against the live project: from the Edge runtime overpass-api.de
// answers 406 and Nominatim 403, while the same query from an ordinary network
// returns 200. Without this retry the chips simply do not work.
test('retries from the phone when the function comes back empty', async () => {
  mockInvoke.mockResolvedValue({ data: { places: [] }, error: null });
  const fetchImpl = overpassOk([
    { type: 'node', lat: 28.62, lon: 77.21, tags: { name: 'Connaught Place Police Station' } },
  ]);

  const places = await findNearestServices('police', DELHI, fetchImpl as never);
  expect(places[0].name).toBe('Connaught Place Police Station');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('retries from the phone when the function itself failed', async () => {
  mockInvoke.mockResolvedValue({ data: null, error: { message: 'Function returned 502' } });
  const fetchImpl = overpassOk([{ type: 'node', lat: 28.62, lon: 77.21, tags: { name: 'Fire HQ' } }]);

  const places = await findNearestServices('fire', DELHI, fetchImpl as never);
  expect(places[0].name).toBe('Fire HQ');
});

test('surfaces the failure when both routes fail', async () => {
  mockInvoke.mockResolvedValue({ data: null, error: { message: 'Function returned 502' } });
  const fetchImpl = jest.fn().mockRejectedValue(new Error('offline'));

  await expect(findNearestServices('fire', DELHI, fetchImpl as never)).rejects.toThrow(/502/);
});

describe('from the device', () => {
  test('sorts by distance and reads a building through its centre', async () => {
    const fetchImpl = overpassOk([
      { type: 'node', lat: 28.70, lon: 77.209, tags: { name: 'Far' } },
      { type: 'way', center: { lat: 28.62, lon: 77.209 }, tags: { name: 'Near' } },
    ]);

    const places = await findNearestFromDevice('hospital', DELHI, fetchImpl as never);
    expect(places?.map((p) => p.name)).toEqual(['Near', 'Far']);
    expect(places?.[0].distanceMeters).toBeLessThan(1000);
  });

  test('names an unnamed one after what it is', async () => {
    const fetchImpl = overpassOk([{ type: 'node', lat: 28.62, lon: 77.21, tags: {} }]);
    const places = await findNearestFromDevice('police', DELHI, fetchImpl as never);
    expect(places?.[0].name).toBe('Police station');
  });

  test('widens the search when nothing is close by', async () => {
    const radii: number[] = [];
    const fetchImpl = jest.fn().mockImplementation((_url: string, init: { body: string }) => {
      radii.push(Number(/around%3A(\d+)/.exec(init.body)![1]));
      return Promise.resolve({
        ok: true,
        json: async () => ({
          elements: radii.length === 3 ? [{ type: 'node', lat: 28.9, lon: 77.3, tags: {} }] : [],
        }),
      } as unknown as Response);
    });

    const places = await findNearestFromDevice('hospital', DELHI, fetchImpl as never);
    expect(radii).toEqual([5000, 15000, 40000]);
    expect(places).toHaveLength(1);
  });

  // An empty answer from a working server is an answer; a refusal is not.
  test('tells a genuine empty area apart from a refusal', async () => {
    const empty = overpassOk([]);
    await expect(findNearestFromDevice('fire', DELHI, empty as never)).resolves.toEqual([]);

    const refused = jest.fn().mockResolvedValue({ ok: false, status: 406 } as unknown as Response);
    await expect(findNearestFromDevice('fire', DELHI, refused as never)).resolves.toBeNull();
  });

  test('identifies itself, because overpass-api.de refuses callers that do not', async () => {
    const fetchImpl = overpassOk([{ type: 'node', lat: 28.62, lon: 77.21, tags: {} }]);
    await findNearestFromDevice('hospital', DELHI, fetchImpl as never);

    const init = fetchImpl.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Accept).toBe('application/json');
    expect(init.headers['User-Agent']).toMatch(/SUTRA/);
  });
});
