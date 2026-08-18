import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

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

jest.mock('@gorhom/bottom-sheet', () => {
  const React2 = require('react');
  const { View, ScrollView } = require('react-native');
  const Sheet = React2.forwardRef((p: any, _ref: any) =>
    React2.createElement(View, null, p.children),
  );
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
  startTelemetry: (...a: unknown[]) => mockStartTelemetry(...a),
  stopTelemetry: (...a: unknown[]) => mockStopTelemetry(...a),
  setDestination: (...a: unknown[]) => mockSetDestination(...a),
  setAlertMessage: (...a: unknown[]) => mockSetAlertMessage(...a),
}));

// Pulls in the real Supabase client otherwise.
jest.mock('../src/directions', () => ({
  fetchRoute: (...a: unknown[]) => mockFetchRoute(...a),
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
  });

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
    await waitFor(() => expect(screen.getByLabelText('Emergency corridor')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('Emergency corridor'));
  };

  // A vehicle an administrator has not authorized must not be offered the
  // control at all, rather than being offered it and refused later.
  it('hides emergency controls for a vehicle without authorization', async () => {
    await render(<Dashboard />);
    await openCorridorPane();
    await waitFor(() => expect(screen.getByText(/Not authorized/i)).toBeTruthy());
    expect(screen.queryByText(/Broadcast Emergency/i)).toBeNull();
  });

  it('shows emergency controls for an authorized vehicle', async () => {
    mockListMyVehicles.mockResolvedValue([vehicle({ is_emergency_authorized: true })]);
    await render(<Dashboard />);
    await openCorridorPane();
    await waitFor(() => expect(screen.getByText(/Broadcast Emergency/i)).toBeTruthy());
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

  it('reports a vehicle that does not belong to the user', async () => {
    mockListMyVehicles.mockResolvedValue([]);
    await render(<Dashboard />);
    await waitFor(() => expect(screen.getByText(/not found/i)).toBeTruthy());
    expect(mockStartTelemetry).not.toHaveBeenCalled();
  });
});
