import React from 'react';
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';

jest.mock('../src/crashlog', () => ({ recordCrash: jest.fn() }));

import { ErrorBoundary } from '../src/ErrorBoundary';
import { recordCrash } from '../src/crashlog';

function Boom(): React.ReactElement {
  throw new Error('render exploded');
}

describe('ErrorBoundary', () => {
  const consoleError = console.error;
  beforeAll(() => {
    // React logs the caught error; silencing keeps the run readable.
    console.error = () => {};
  });
  afterAll(() => {
    console.error = consoleError;
  });

  beforeEach(() => jest.clearAllMocks());

  it('renders children when nothing throws', async () => {
    await render(
      <ErrorBoundary>
        <Text>all good</Text>
      </ErrorBoundary>,
    );
    expect(screen.getByText('all good')).toBeTruthy();
  });

  // Without a boundary a render fault unmounts the tree and the app simply
  // disappears, which is indistinguishable from a crash.
  it('keeps something on screen when a child throws', async () => {
    await render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/Something broke/i)).toBeTruthy();
  });

  it('shows the fault verbatim so it can be reported', async () => {
    await render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('render exploded')).toBeTruthy();
  });

  it('persists the fault so it survives a restart', async () => {
    await render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(recordCrash).toHaveBeenCalled();
  });
});
