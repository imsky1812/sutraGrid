import React from 'react';
import { Keyboard } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockStartTelemetry = jest.fn().mockResolvedValue(undefined);
const mockStopTelemetry = jest.fn().mockResolvedValue(undefined);
const mockSetDestination = jest.fn();
const mockSetAlertMessage = jest.fn();
const mockListMyVehicles = jest.fn();
const mockFetchRoute = jest.fn().mockResolvedValue([]);

jest.mock('@maplibre/maplibre-react-native', () => {
  const React2 = require('react');
  const { View } = require('react-native');
  const passthrough = (testID: string) => (p: any) =>
    React2.createElement(View, { testID }, p.children ?? null);
  return {
    __esModule: true,
    Map: passthrough('map'),
    Camera: passthrough('camera'),
    UserLocation: passthrough('user-location'),
    GeoJSONSource: passthrough('route-source'),
    Layer: passthrough('route-layer'),
    Marker: passthrough('marker'),
  };
});

const mockSnapToIndex = jest.fn();

jest.mock('@gorhom/bottom-sheet', () => {
  const React2 = require('react');
  const { View, ScrollView } = require('react-native');
  const Sheet = React2.forwardRef((p: any, ref: any) => {
    React2.useImperativeHandle(ref, () => ({ snapToIndex: mockSnapToIndex }));
    return React2.createElement(View, null, p.children);
  });
  return {
    __esModule: true,
    default: Sheet,
    BottomSheetScrollView: (p: any) => React2.createElement(ScrollView, null, p.children),
  };
});

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ vehicleId: 'veh-1' }),
  router: { replace: jest.fn() },
}));

jest.mock('../src/vehicles', () => ({
  listMyVehicles: (...a: unknown[]) => mockListMyVehicles(...a),
}));

jest.mock('../src/telemetry', () => ({
  // The cadence is a pure function of the vehicle; the real one is the point.
  cadenceFor: jest.requireActual('../src/telemetry').cadenceFor,
  startTelemetry: (...a: unknown[]) => mockStartTelemetry(...a),
  stopTelemetry: (...a: unknown[]) => mockStopTelemetry(...a),
  setDestination: (...a: unknown[]) => mockSetDestination(...a),
  setAlertMessage: (...a: unknown[]) => mockSetAlertMessage(...a),
}));

// Pull in the real Supabase client otherwise.
jest.mock('../src/directions', () => ({
  fetchRoute: (...a: unknown[]) => mockFetchRoute(...a),
}));

const mockFindNearestServices = jest.fn();

jest.mock('../src/places', () => ({
  searchPlaces: jest.fn().mockResolvedValue([]),
  describePoint: jest.fn().mockResolvedValue('Pinned point'),
  findNearestServices: (...a: unknown[]) => mockFindNearestServices(...a),
}));

const NEAREST_HOSPITAL = {
  name: 'City General Hospital',
  latitude: 12.976,
  longitude: 77.601,
  distanceMeters: 640,
};

const mockWatchSurroundings = jest.fn();

jest.mock('../src/surroundings', () => ({
  ...jest.requireActual('../src/surroundings'),
  watchSurroundings: (...a: unknown[]) => mockWatchSurroundings(...a),
}));

const NEIGHBOUR = {
  ref: 'abc123',
  lat: 12.9716,
  lng: 77.5946,
  speed: 36,
  heading: 0,
  vehicle_type: 'AMBULANCE',
  is_emergency: true,
  warned: false,
  seenAt: Date.now(),
};

const mockPlanCorridor = jest.fn();
const mockStartCorridor = jest.fn();
const mockEndCorridor = jest.fn();

// The network calls are faked; the pure helpers (progress, next signal) are real.
jest.mock('../src/corridor', () => ({
  ...jest.requireActual('../src/corridor'),
  planCorridor: (...a: unknown[]) => mockPlanCorridor(...a),
  startCorridor: (...a: unknown[]) => mockStartCorridor(...a),
  endCorridor: (...a: unknown[]) => mockEndCorridor(...a),
  fetchSignals: jest.fn().mockResolvedValue([
    { id: 1, seq: 1, lat: 12.975, lng: 77.59, along_m: 550, state: 'PREEMPT' },
  ]),
  watchCorridor: jest.fn().mockReturnValue(() => {}),
}));

import Dashboard from '../app/dashboard';

const vehicle = (overrides = {}) => ({
  id: 'veh-1',
  vehicle_number: 'KA-03-AB-1234',
  driver_name: 'Driver A',
  vehicle_type: 'NORMAL',
  is_emergency_authorized: false,
  ...overrides,
});

describe('Dashboard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStartTelemetry.mockResolvedValue(undefined);
    mockStopTelemetry.mockResolvedValue(undefined);
    mockFetchRoute.mockResolvedValue([]);
    mockListMyVehicles.mockResolvedValue([vehicle()]);
    mockFindNearestServices.mockResolvedValue([NEAREST_HOSPITAL]);
    mockWatchSurroundings.mockImplementation((_id, _cadence, onChange) => {
      onChange([NEIGHBOUR]);
      return () => {};
    });
  });

  const openAroundPane = async () => {
    await waitFor(() => expect(screen.getByLabelText('Around me')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('Around me'));
  };

  /** Tap the hospital chip and wait for it to become the real nearest one. */
  const chooseNearestHospital = async () => {
    await waitFor(() => expect(screen.getByText('Nearest hospital')).toBeTruthy());
    fireEvent.press(screen.getByText('Nearest hospital'));
    await waitFor(() => expect(screen.getByText(/City General Hospital ·/)).toBeTruthy());
  };

  it('starts telemetry for the selected vehicle', async () => {
    await render(<Dashboard />);
    await waitFor(() =>
      expect(mockStartTelemetry).toHaveBeenCalledWith(expect.objectContaining({ id: 'veh-1' })),
    );
  });

  it('shows the vehicle number once loaded', async () => {
    await render(<Dashboard />);
    await waitFor(() => expect(screen.getByText('KA-03-AB-1234')).toBeTruthy());
  });

  // The corridor control lives behind its own pane, so these open it the way a
  // driver would rather than asserting against the default view.
  const openCorridorPane = async () => {
    await waitFor(() => expect(screen.getByLabelText('Green corridor')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('Green corridor'));
  };

  // A vehicle an administrator has not authorized must not be offered the
  // control at all, rather than being offered it and refused later.
  it('hides emergency controls for a vehicle without authorization', async () => {
    await render(<Dashboard />);
    await openCorridorPane();
    await waitFor(() => expect(screen.getByText(/Not authorized/i)).toBeTruthy());
    expect(screen.queryByText(/Start green corridor/i)).toBeNull();
  });

  it('shows emergency controls for an authorized vehicle', async () => {
    mockListMyVehicles.mockResolvedValue([vehicle({ is_emergency_authorized: true })]);
    await render(<Dashboard />);
    await openCorridorPane();
    await waitFor(() => expect(screen.getByText(/Start green corridor/i)).toBeTruthy());
  });

  // These chips were three fixed Bengaluru coordinates, so a driver in Delhi
  // who tapped "police" got a 2,000 km route. They must now be looked up
  // against the driver's own position, and must refuse rather than guess.
  describe('emergency services', () => {
    it('looks up the nearest service around the driver', async () => {
      await render(<Dashboard />);
      await chooseNearestHospital();

      // The driver's own position from the location mock - not a city centre.
      expect(mockFindNearestServices).toHaveBeenCalledWith('hospital', {
        latitude: 12.97,
        longitude: 77.59,
      });
      expect(mockSetDestination).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'City General Hospital' }),
      );
    });

    it('shows how far away the one it found is', async () => {
      await render(<Dashboard />);
      await chooseNearestHospital();
      expect(screen.getByText(/City General Hospital · 640 m/)).toBeTruthy();
    });

    it('asks only once per service', async () => {
      await render(<Dashboard />);
      await chooseNearestHospital();
      fireEvent.press(screen.getByText(/City General Hospital ·/));
      await waitFor(() => expect(mockFetchRoute).toHaveBeenCalledTimes(2));
      expect(mockFindNearestServices).toHaveBeenCalledTimes(1);
    });

    it('says so when nothing of that kind is mapped nearby', async () => {
      mockFindNearestServices.mockResolvedValue([]);
      await render(<Dashboard />);
      await waitFor(() => expect(screen.getByText('Nearest fire station')).toBeTruthy());
      fireEvent.press(screen.getByText('Nearest fire station'));
      await waitFor(() => expect(screen.getByText(/Nothing of that kind is mapped/i)).toBeTruthy());
    });

    it('reports a lookup failure rather than routing somewhere wrong', async () => {
      mockFindNearestServices.mockRejectedValue(new Error('Could not look up the nearest police station.'));
      await render(<Dashboard />);
      await waitFor(() => expect(screen.getByText('Nearest police')).toBeTruthy());
      fireEvent.press(screen.getByText('Nearest police'));
      await waitFor(() => expect(screen.getByText(/Could not look up/i)).toBeTruthy());
      expect(mockFetchRoute).not.toHaveBeenCalled();
    });
  });

  // The connected-vehicle answer to Tesla's camera view: the SUTRA vehicles
  // around the driver, polled because RLS makes a subscription return only the
  // driver's own row.
  describe('around me', () => {
    it('watches the surroundings only while the pane is open', async () => {
      await render(<Dashboard />);
      await waitFor(() => expect(screen.getByLabelText('Route')).toBeTruthy());
      expect(mockWatchSurroundings).not.toHaveBeenCalled();

      await openAroundPane();
      await waitFor(() =>
        expect(mockWatchSurroundings).toHaveBeenCalledWith('veh-1', 3000, expect.any(Function), expect.any(Function)),
      );
    });

    it('polls at the emergency cadence for an authorized vehicle', async () => {
      mockListMyVehicles.mockResolvedValue([vehicle({ is_emergency_authorized: true })]);
      await render(<Dashboard />);
      await openAroundPane();
      await waitFor(() =>
        expect(mockWatchSurroundings).toHaveBeenCalledWith('veh-1', 1000, expect.any(Function), expect.any(Function)),
      );
    });

    it('draws what it found on the radar', async () => {
      await render(<Dashboard />);
      await openAroundPane();
      await waitFor(() => expect(screen.getByTestId('radar')).toBeTruthy());
      expect(screen.getByTestId(`radar-vehicle-${NEIGHBOUR.ref}`)).toBeTruthy();
    });

    it('swaps the radar for map markers', async () => {
      await render(<Dashboard />);
      await openAroundPane();
      await waitFor(() => expect(screen.getByText('Map')).toBeTruthy());
      fireEvent.press(screen.getByText('Map'));

      await waitFor(() => expect(screen.queryByTestId('radar')).toBeNull());
      expect(screen.getByTestId(`map-vehicle-${NEIGHBOUR.ref}`)).toBeTruthy();
    });

    // A jury will ask what this can and cannot see. The answer belongs on the
    // screen, like the corridor's SIM badge.
    it('states that it only sees SUTRA vehicles', async () => {
      await render(<Dashboard />);
      await openAroundPane();
      await waitFor(() => expect(screen.getByText(/Only vehicles running SUTRA/i)).toBeTruthy());
    });
  });

  describe('green corridor', () => {
    const PLAN = {
      route: [
        [12.97, 77.59],
        [12.988, 77.59],
      ],
      distanceMeters: 1990,
      durationSeconds: 180,
      signals: [{ osm_id: 1, lat: 12.975, lng: 77.59 }],
      signalsAvailable: true,
    };

    beforeEach(() => {
      mockListMyVehicles.mockResolvedValue([vehicle({ is_emergency_authorized: true })]);
      mockPlanCorridor.mockResolvedValue(PLAN);
      mockStartCorridor.mockResolvedValue('corridor-1');
      mockEndCorridor.mockResolvedValue(undefined);
    });

    const startOne = async () => {
      await render(<Dashboard />);
      await chooseNearestHospital();
      await openCorridorPane();
      await waitFor(() => expect(screen.getByText(/Start green corridor/i)).toBeTruthy());
      fireEvent.press(screen.getByText(/Start green corridor/i));
      await waitFor(() => expect(screen.getByText('Green corridor active')).toBeTruthy());
    };

    it('plans and starts a corridor to the chosen destination', async () => {
      await startOne();
      expect(mockPlanCorridor).toHaveBeenCalledWith(
        expect.anything(),
        { latitude: 12.976, longitude: 77.601 },
      );
      expect(mockStartCorridor).toHaveBeenCalledWith('veh-1', 'City General Hospital', PLAN);
    });

    // The signal states are simulated. That must be visible whenever they are.
    it('labels the signal states as simulated', async () => {
      await startOne();
      expect(screen.getByText('SIM')).toBeTruthy();
      expect(screen.getByText(/Signal states are simulated/i)).toBeTruthy();
    });

    it('shows the next junction from the live signals', async () => {
      await startOne();
      await waitFor(() => expect(screen.getByText(/Next junction .* Clearing/)).toBeTruthy());
    });

    it('ends the corridor on request', async () => {
      await startOne();
      fireEvent.press(screen.getByText(/End green corridor/i));
      await waitFor(() => expect(mockEndCorridor).toHaveBeenCalledWith('corridor-1'));
      await waitFor(() => expect(screen.queryByText('Green corridor active')).toBeNull());
    });

    // Otherwise drivers keep being told to give way to an ambulance that has
    // left the app.
    it('ends the corridor when the screen closes', async () => {
      await startOne();
      await screen.unmount();
      expect(mockEndCorridor).toHaveBeenCalledWith('corridor-1');
    });

    it('explains a refusal from the server', async () => {
      mockStartCorridor.mockRejectedValue(new Error('This vehicle is not authorized to open a green corridor.'));
      await render(<Dashboard />);
      await chooseNearestHospital();
      await openCorridorPane();
      await waitFor(() => expect(screen.getByText(/Start green corridor/i)).toBeTruthy());
      fireEvent.press(screen.getByText(/Start green corridor/i));
      await waitFor(() => expect(screen.getByText(/not authorized to open/i)).toBeTruthy());
    });
  });

  it('surfaces a telemetry start failure instead of failing silently', async () => {
    mockStartTelemetry.mockRejectedValue(new Error('Background location is required'));
    await render(<Dashboard />);
    await waitFor(() => expect(screen.getByText(/Background location is required/i)).toBeTruthy());
  });

  it('stops telemetry on unmount so the service does not outlive the screen', async () => {
    const { unmount } = await render(<Dashboard />);
    await waitFor(() => expect(mockStartTelemetry).toHaveBeenCalled());
    await unmount();
    expect(mockStopTelemetry).toHaveBeenCalled();
  });

  describe('keyboard', () => {
    // Captures the screen's keyboard listeners so a test can open the keyboard.
    const keyboard = () => {
      const handlers: Record<string, () => void> = {};
      jest.spyOn(Keyboard, 'addListener').mockImplementation((event: any, handler: any) => {
        handlers[event] = handler;
        return { remove: jest.fn() } as any;
      });
      return {
        show: () => act(() => handlers.keyboardDidShow?.()),
        hide: () => act(() => handlers.keyboardDidHide?.()),
      };
    };

    afterEach(() => jest.restoreAllMocks());

    // The sheet opens to the top so the search box sits above the keyboard.
    it('raises the sheet when the keyboard opens', async () => {
      const kb = keyboard();
      await render(<Dashboard />);
      await waitFor(() => expect(screen.getByPlaceholderText(/Hospital, street/)).toBeTruthy());
      await kb.show();
      expect(mockSnapToIndex).toHaveBeenLastCalledWith(1);
    });

    // Header and tabs step aside so the field is near the top of the sheet,
    // which is above the keyboard on any phone.
    it('moves the text box to the top of the sheet while typing', async () => {
      const kb = keyboard();
      await render(<Dashboard />);
      await waitFor(() => expect(screen.getByText('No destination set')).toBeTruthy());
      await kb.show();
      expect(screen.queryByText('No destination set')).toBeNull();
      expect(screen.queryByLabelText('Green corridor')).toBeNull();
      expect(screen.getByPlaceholderText(/Hospital, street/)).toBeTruthy();
    });

    it('puts the sheet back when the keyboard closes', async () => {
      const kb = keyboard();
      await render(<Dashboard />);
      await waitFor(() => expect(screen.getByText('No destination set')).toBeTruthy());
      await kb.show();
      await kb.hide();
      expect(mockSnapToIndex).toHaveBeenLastCalledWith(0);
      expect(screen.getByText('No destination set')).toBeTruthy();
    });
  });

  it('reports a vehicle that does not belong to the user', async () => {
    mockListMyVehicles.mockResolvedValue([]);
    await render(<Dashboard />);
    await waitFor(() => expect(screen.getByText(/not found/i)).toBeTruthy());
    expect(mockStartTelemetry).not.toHaveBeenCalled();
  });
});
