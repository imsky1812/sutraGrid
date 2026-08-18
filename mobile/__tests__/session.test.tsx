import React from 'react';
import { Text } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';

const mockGetSession = jest.fn();
const mockOnAuthStateChange = jest.fn();
const mockUnsubscribe = jest.fn();

jest.mock('../src/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...a: unknown[]) => mockGetSession(...a),
      onAuthStateChange: (...a: unknown[]) => mockOnAuthStateChange(...a),
    },
  },
}));

import { SessionProvider, useSession } from '../src/session';

function Probe() {
  const { session, loading } = useSession();
  return <Text>{loading ? 'loading' : session ? 'in' : 'out'}</Text>;
}

// react-native-testing-library v14 returns a promise from render; it has to be
// awaited or every query and the unmount handle come back undefined.
const renderProbe = () =>
  render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );

describe('SessionProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOnAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: mockUnsubscribe } },
    });
  });

  it('resolves to signed-out when there is no stored session', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    await renderProbe();
    await waitFor(() => expect(screen.getByText('out')).toBeTruthy());
  });

  it('resolves to signed-in when a session is restored', async () => {
    mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'u1' } } } });
    await renderProbe();
    await waitFor(() => expect(screen.getByText('in')).toBeTruthy());
  });

  it('subscribes to auth state changes', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    await renderProbe();
    await waitFor(() => expect(mockOnAuthStateChange).toHaveBeenCalled());
  });

  // A leaked subscription keeps a stale setState alive across remounts, which
  // surfaces later as an update-on-unmounted-component warning.
  it('unsubscribes on unmount', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    const { unmount } = await renderProbe();
    await waitFor(() => expect(screen.getByText('out')).toBeTruthy());
    await unmount();
    expect(mockUnsubscribe).toHaveBeenCalled();
  });
});
