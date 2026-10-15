// The driver-centred view.
//
// The thing worth testing is placement: a vehicle ahead must be drawn above the
// driver, one to the right must be drawn right, and that has to stay true as
// the driver turns. Getting that backwards would be convincing and wrong.

import { render, screen } from '@testing-library/react-native';
import { describeNeighbour, Radar } from '../src/Radar';
import { project } from '../src/geo';
import type { TrackedNeighbour } from '../src/surroundings';

const HERE: [number, number] = [28.6139, 77.209];
const NOW = 1_000_000;
const SIZE = 200;

const at = (bearingDeg: number, metres: number, overrides: Partial<TrackedNeighbour> = {}) => {
  const [lat, lng] = project(HERE, bearingDeg, metres);
  return {
    ref: `v-${bearingDeg}-${metres}`,
    lat,
    lng,
    speed: 0,
    heading: bearingDeg,
    vehicle_type: 'NORMAL',
    is_emergency: false,
    warned: false,
    seenAt: NOW,
    ...overrides,
  } as TrackedNeighbour;
};

const draw = async (neighbours: TrackedNeighbour[], heading = 0) =>
  render(
    <Radar here={HERE} heading={heading} neighbours={neighbours} rangeM={400} now={NOW} size={SIZE} />,
  );

/** Where the component actually put it, as {left, top} in pixels. */
const placed = (ref: string) => {
  const style = screen.getByTestId(`radar-vehicle-${ref}`).props.style;
  const flat = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
  return { left: flat.left as number, top: flat.top as number };
};

const CENTRE = SIZE / 2 - 7; // the dot is 14 wide, positioned by its corner

test('a vehicle ahead is drawn above the driver', async () => {
  const north = at(0, 200);
  await draw([north]);
  const { left, top } = placed(north.ref);
  expect(top).toBeLessThan(CENTRE);
  expect(left).toBeCloseTo(CENTRE, 0);
});

test('a vehicle to the right is drawn to the right', async () => {
  const east = at(90, 200);
  await draw([east]);
  const { left, top } = placed(east.ref);
  expect(left).toBeGreaterThan(CENTRE);
  expect(top).toBeCloseTo(CENTRE, 0);
});

// This is the difference between a radar and a map, and the easiest thing to
// get wrong: the view is relative to where the driver is pointing.
test('the view turns with the driver', async () => {
  const north = at(0, 200);
  await draw([north], 90); // driver now heading east
  const { left, top } = placed(north.ref);
  expect(left).toBeLessThan(CENTRE); // what was ahead is now on the left
  expect(top).toBeCloseTo(CENTRE, 0);
});

test('distance scales toward the rim', async () => {
  const near = at(0, 100);
  const far = at(0, 380);
  await draw([near, far]);
  expect(placed(far.ref).top).toBeLessThan(placed(near.ref).top);
});

// Dropping it would make a vehicle vanish just as it becomes interesting.
test('something beyond the range is pinned to the rim, not dropped', async () => {
  const beyond = at(0, 5000);
  const edge = at(0, 400);
  await draw([beyond, edge]);
  expect(placed(beyond.ref).top).toBeCloseTo(placed(edge.ref).top, 0);
});

test('an emergency vehicle and a warned one are marked', async () => {
  const amb = at(0, 100, { is_emergency: true, vehicle_type: 'AMBULANCE' });
  const warned = at(180, 100, { warned: true });
  await draw([amb, warned]);

  const styleOf = (ref: string) => {
    const style = screen.getByTestId(`radar-vehicle-${ref}`).props.style;
    return Object.assign({}, ...style.filter(Boolean));
  };
  expect(styleOf(amb.ref).backgroundColor).toBe('#22C55E');
  expect(styleOf(warned.ref).borderWidth).toBe(2);
});

test('the driver is always on screen', async () => {
  await draw([]);
  expect(screen.getByTestId('radar-ego')).toBeTruthy();
});

// An empty radar means nobody nearby is sharing. It must not read as "clear".
test('says why it is empty', async () => {
  await draw([]);
  expect(screen.getByText(/No SUTRA vehicles nearby/i)).toBeTruthy();
});

test('says so when there is no location yet', async () => {
  await render(
    <Radar here={null} heading={0} neighbours={[at(0, 100)]} rangeM={400} now={NOW} size={SIZE} />,
  );
  expect(screen.getByText(/Waiting for your location/i)).toBeTruthy();
  expect(screen.queryByTestId(`radar-vehicle-${at(0, 100).ref}`)).toBeNull();
});

describe('describeNeighbour', () => {
  const say = (bearingDeg: number, metres: number, speed = 40) =>
    describeNeighbour(HERE, 0, at(bearingDeg, metres, { speed }), NOW);

  test('reads as a driver would say it', () => {
    expect(say(0, 80)).toMatch(/^80 m ahead · 40 km\/h$/);
    expect(say(90, 120)).toMatch(/to your right/);
    expect(say(270, 120)).toMatch(/to your left/);
    expect(say(180, 120)).toMatch(/behind/);
  });

  test('switches to kilometres when it is far', () => {
    expect(say(0, 1500)).toMatch(/1\.5 km/);
  });
});
