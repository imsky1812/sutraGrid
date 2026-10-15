// A driver's own trips and rule breaks.

const mockRpc = jest.fn();
const mockViolations = jest.fn();

jest.mock('../src/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => mockRpc(...a),
    from: () => ({
      select: () => ({
        eq: () => ({
          gte: () => ({ order: () => ({ limit: () => mockViolations() }) }),
        }),
      }),
    }),
  },
}));

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({ vehicleId: 'veh-1', plate: 'UP 32 G 6789' }),
}));

import { render, screen, waitFor } from '@testing-library/react-native';
import History from '../app/history';
import { describeViolation, formatDuration, summarize, type Trip, type Violation } from '../src/history';

const trip = (over: Partial<Trip> = {}): Trip => ({
  trip_no: 1,
  started_at: '2026-10-14T09:00:00Z',
  ended_at: '2026-10-14T09:26:00Z',
  points: 520,
  distance_m: 14_200,
  top_speed: 84,
  violations: 1,
  ...over,
});

const violation = (over: Partial<Violation> = {}): Violation => ({
  kind: 'SPEEDING',
  speed: 95,
  speed_limit: 80,
  lat: 28.6,
  lng: 77.2,
  occurred_at: '2026-10-14T09:10:00Z',
  cleared_at: '2026-10-14T09:10:40Z',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRpc.mockResolvedValue({ data: [trip()], error: null });
  mockViolations.mockResolvedValue({ data: [violation()], error: null });
});

describe('the screen', () => {
  it('asks for this vehicle’s trips over the last week', async () => {
    await render(<History />);
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('vehicle_trips', { p_vehicle_id: 'veh-1', p_days: 7 }),
    );
  });

  it('shows the trip with its distance, duration and top speed', async () => {
    await render(<History />);
    await waitFor(() => expect(screen.getByText(/14\.2 km · 26 min · top 84 km\/h/)).toBeTruthy());
  });

  it('lists the rule break in plain words', async () => {
    await render(<History />);
    await waitFor(() => expect(screen.getByText('Speeding · peak 95 km/h')).toBeTruthy());
    expect(screen.getByText('15 km/h over the 80 limit for 40s')).toBeTruthy();
  });

  // Otherwise an empty week reads as a broken screen.
  it('explains an empty week, including why parking does not count', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    mockViolations.mockResolvedValue({ data: [], error: null });
    await render(<History />);
    await waitFor(() => expect(screen.getByText(/Time spent parked is not counted/)).toBeTruthy());
    expect(screen.getByText('None this week.')).toBeTruthy();
  });

  it('says what went wrong rather than showing nothing', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'JWT expired' } });
    await render(<History />);
    await waitFor(() => expect(screen.getByText('JWT expired')).toBeTruthy());
  });
});

describe('summarize', () => {
  it('adds the week up', () => {
    const s = summarize([trip(), trip({ distance_m: 5_800, top_speed: 61, violations: 0 })]);
    expect(s.km).toBeCloseTo(20, 5);
    expect(s.minutes).toBeCloseTo(52, 5);
    expect(s.topSpeed).toBe(84);
    expect(s.ruleBreaks).toBe(1);
  });

  it('is all zeros for no trips', () => {
    expect(summarize([])).toEqual({ km: 0, minutes: 0, topSpeed: 0, ruleBreaks: 0 });
  });
});

describe('describeViolation', () => {
  it('says which road or zone set the limit', () => {
    const v = violation({ speed: 60, speed_limit: 40, detail: { place: 'Crossings Republik Road' } });
    expect(describeViolation(v).detail).toBe('20 km/h over the 40 limit on Crossings Republik Road for 40s');
  });

  it('says when speeding is still going on', () => {
    expect(describeViolation(violation({ cleared_at: null })).detail).toMatch(/still going/);
  });

  it('switches to minutes for a long episode', () => {
    const long = violation({ cleared_at: '2026-10-14T09:13:00Z' });
    expect(describeViolation(long).detail).toMatch(/for 3 min$/);
  });

  it('says how hard the braking was, and which road was driven the wrong way', () => {
    const brake = violation({ kind: 'HARSH_BRAKE', detail: { from_kmh: 60, to_kmh: 25, seconds: 2 } });
    expect(describeViolation(brake).detail).toBe('From 60 to 25 km/h in 2s');
    const wrong = violation({ kind: 'WRONG_WAY', speed: 30, detail: { road: 'MG Road' } });
    expect(describeViolation(wrong).detail).toBe('Against one-way MG Road at 30 km/h');
  });

  it('describes the other kinds without talking about a limit', () => {
    expect(describeViolation(violation({ kind: 'HARSH_BRAKE', speed: 62 })).title).toBe('Harsh braking');
    expect(describeViolation(violation({ kind: 'WRONG_WAY' })).title).toBe('Wrong way');
    expect(describeViolation(violation({ kind: 'HARSH_BRAKE' })).detail).not.toMatch(/limit/);
  });
});

it('formats durations the way people say them', () => {
  expect(formatDuration(0.2)).toBe('1 min');
  expect(formatDuration(95)).toBe('1 h 35 min');
});
