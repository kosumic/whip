import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';
import {
  initializeUsageTracking,
  setUsageForeground,
} from 'react-native-whip-ssh';

import { useUsageTracking } from '../src/hooks/useUsageTracking';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));
jest.mock('react-native-whip-ssh', () => ({
  initializeUsageTracking: jest.fn(),
  setUsageForeground: jest.fn(),
}));
jest.mock('expo-file-system', () => ({
  Paths: { document: 'file:///documents/' },
  Directory: jest.fn(() => ({ create: jest.fn() })),
  File: jest.fn(() => ({ uri: 'file:///documents/usage/usage.json' })),
}));
jest.mock('../src/services/operationalDiagnostics', () => ({
  recordOperationalDiagnostic: jest.fn(),
  operationalErrorDetails: jest.fn(() => ({})),
}));

function Harness() {
  useUsageTracking();
  return null;
}

let renderer: ReactTestRenderer;

function transition(state: AppStateStatus) {
  AppState.currentState = state;
  const listener = jest.mocked(AppState.addEventListener).mock.calls[0][1];
  act(() => listener(state));
}

afterEach(() => {
  act(() => renderer?.unmount());
  jest.clearAllMocks();
  AppState.currentState = 'active';
});

it('tracks foreground with no hosts and forwards background, resume, and detach', () => {
  act(() => {
    renderer = create(<Harness />);
  });
  expect(initializeUsageTracking).toHaveBeenCalledWith(
    '/documents/usage/usage.json',
  );
  expect(setUsageForeground).toHaveBeenLastCalledWith(true);
  transition('background');
  expect(setUsageForeground).toHaveBeenLastCalledWith(false);
  transition('active');
  expect(setUsageForeground).toHaveBeenLastCalledWith(true);
  const subscription = jest.mocked(AppState.addEventListener).mock.results[0]
    .value;
  act(() => renderer.unmount());
  expect(subscription.remove).toHaveBeenCalled();
  expect(setUsageForeground).toHaveBeenLastCalledWith(false);
});

it('starts inactive during a background launch and retries failed initialization on resume', () => {
  AppState.currentState = 'background';
  jest.mocked(initializeUsageTracking).mockImplementationOnce(() => {
    throw new Error('Storage unavailable');
  });
  act(() => {
    renderer = create(<Harness />);
  });
  expect(setUsageForeground).not.toHaveBeenCalledWith(true);
  transition('active');
  expect(initializeUsageTracking).toHaveBeenCalledTimes(2);
  expect(setUsageForeground).toHaveBeenLastCalledWith(true);
});
