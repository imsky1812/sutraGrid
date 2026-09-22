import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockListMyVehicles = jest.fn();

jest.mock('../src/vehicles', () => ({
  ...jest.requireActual('../src/vehicles'),
  listMyVehicles: (...a: unknown[]) => mockListMyVehicles(...a),
  registerVehicle: jest.fn(),
}));

jest.mock('../src/supabase', () => ({ supabase: { auth: { signOut: jest.fn() } } }));

jest.mock('expo-router', () => ({ router: { replace: jest.fn() } }));

import VehicleSetup from '../app/vehicle-setup';

const VEHICLE = {
  id: 'veh-1',
  vehicle_number: 'UP 32 G 6789',
  driver_name: 'Driver',
  vehicle_type: 'NORMAL',
  is_emergency_authorized: false,
};

describe('VehicleSetup', () => {
  beforeEach(() => mockListMyVehicles.mockResolvedValue([VEHICLE]));

  it('lists the driver vehicles', async () => {
    await render(<VehicleSetup />);
    await waitFor(() => expect(screen.getByText('UP 32 G 6789')).toBeTruthy());
  });

  // The form used to share the screen with the list, and the keyboard covered
  // the fields. While registering, the form gets the whole screen.
  it('gives the registration form the whole screen', async () => {
    await render(<VehicleSetup />);
    await waitFor(() => expect(screen.getByText('Register a vehicle')).toBeTruthy());
    await fireEvent.press(screen.getByText('Register a vehicle'));

    await waitFor(() => expect(screen.getByPlaceholderText('KA-03-AB-1234')).toBeTruthy());
    expect(screen.queryByText('UP 32 G 6789')).toBeNull();
  });

  it('brings the list back on cancel', async () => {
    await render(<VehicleSetup />);
    await waitFor(() => expect(screen.getByText('Register a vehicle')).toBeTruthy());
    await fireEvent.press(screen.getByText('Register a vehicle'));
    await waitFor(() => expect(screen.getByText('Cancel')).toBeTruthy());
    await fireEvent.press(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.getByText('UP 32 G 6789')).toBeTruthy());
  });
});
