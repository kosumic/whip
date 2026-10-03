import { NativeModules, Platform } from 'react-native';
import {
  configureBackgroundMonitoring,
  observeMonitoringNetwork,
} from '../src/services/backgroundMonitoring';
import { reportBackgroundFailure } from '../src/services/backgroundOperations';

const mockRemove = jest.fn();
let mockEmit: (available: boolean) => void;
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {
    HerdrBackground: {
      configure: jest.fn(() => Promise.resolve()),
      networkAvailable: jest.fn(),
    },
  },
  NativeEventEmitter: jest.fn(() => ({
    addListener: jest.fn((_name, callback) => {
      mockEmit = callback;
      return { remove: mockRemove };
    }),
  })),
}));
jest.mock('../src/services/backgroundOperations', () => ({
  reportBackgroundFailure: jest.fn((promise: Promise<unknown>) => promise),
}));

beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
});

test('a late initial snapshot cannot overwrite a newer route event', async () => {
  let resolve!: (available: boolean) => void;
  NativeModules.HerdrBackground.networkAvailable.mockReturnValue(
    new Promise<boolean>(done => { resolve = done; }),
  );
  const onChange = jest.fn();
  const unsubscribe = observeMonitoringNetwork(onChange);
  mockEmit(false);
  resolve(true);
  await Promise.resolve();
  expect(onChange.mock.calls).toEqual([[false]]);
  // An available-to-available callback still carries a route-change signal.
  mockEmit(true);
  mockEmit(true);
  expect(onChange.mock.calls).toEqual([[false], [true], [true]]);
  unsubscribe();
  expect(mockRemove).toHaveBeenCalledTimes(1);
});

test('teardown ignores pending initial state and late native delivery', async () => {
  NativeModules.HerdrBackground.networkAvailable.mockResolvedValue(true);
  const onChange = jest.fn();
  const unsubscribe = observeMonitoringNetwork(onChange);
  unsubscribe();
  mockEmit(false);
  await Promise.resolve();
  expect(onChange).not.toHaveBeenCalled();
  expect(reportBackgroundFailure).toHaveBeenCalledWith(
    expect.any(Promise), 'monitoring-network-initial-state',
  );
});

test('configuration forwards monitoring independently of notification permission', async () => {
  await configureBackgroundMonitoring(2, 1, 'power-saving', false);
  expect(NativeModules.HerdrBackground.configure)
    .toHaveBeenCalledWith(2, 1, 'power-saving', false);
  Platform.OS = 'ios';
  await configureBackgroundMonitoring(2, 1, 'continuous', true);
  const unsubscribe = observeMonitoringNetwork(jest.fn());
  unsubscribe();
  expect(NativeModules.HerdrBackground.configure).toHaveBeenCalledTimes(1);
});
