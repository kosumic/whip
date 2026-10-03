import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { useLiveHostMonitoring } from '../src/hooks/useLiveHostMonitoring';
import { configureBackgroundMonitoring } from '../src/services/backgroundMonitoring';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: jest.fn() },
  Platform: { OS: 'android' },
}));
jest.mock('../src/services/latencyDiagnostics', () => ({
  flushLatencyDiagnosticWrites: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/services/networkDiagnostics', () => ({ recordNetworkDiagnostic: jest.fn() }));
let mockNetworkChange: (available: boolean) => void;
const mockRemoveNetwork = jest.fn();
jest.mock('../src/services/backgroundMonitoring', () => ({
  configureBackgroundMonitoring: jest.fn(() => Promise.resolve()),
  observeMonitoringNetwork: jest.fn(callback => {
    mockNetworkChange = callback;
    return mockRemoveNetwork;
  }),
}));

type Options = Parameters<typeof useLiveHostMonitoring>[0];
function Harness(props: Options) {
  useLiveHostMonitoring(props);
  return null;
}

describe('native monitoring lifecycle', () => {
  let renderer: ReactTestRenderer;
  let onState: (state: AppStateStatus) => void;
  const removeAppState = jest.fn();
  const setRuntimeMonitoringState = jest.fn();
  const options: Options = {
    hostCount: 1, connectedHostCount: 1, runtimeKey: 'host:ready',
    backgroundMonitoringMode: 'continuous', restoreComplete: true,
    hostsVisible: true, appAccessLocked: false,
    setRuntimeMonitoringState, onBackgroundMonitoringError: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    Platform.OS = 'android';
    AppState.currentState = 'active';
    jest.mocked(AppState.addEventListener).mockImplementation((_event, callback) => {
      onState = callback;
      return { remove: removeAppState };
    });
    act(() => { renderer = create(<Harness {...options} />); });
  });
  afterEach(() => { act(() => renderer.unmount()); });

  test('updates policy without duplicate listeners or a false background transition', () => {
    expect(setRuntimeMonitoringState).toHaveBeenLastCalledWith(true, true, false, 'continuous', true, 0);
    setRuntimeMonitoringState.mockClear();
    act(() => renderer.update(
      <Harness {...options} backgroundMonitoringMode="power-saving" hostsVisible={false} />,
    ));
    expect(setRuntimeMonitoringState.mock.calls).toEqual([[true, false, false, 'power-saving', true, 0]]);
    expect(AppState.addEventListener).toHaveBeenCalledTimes(1);
    act(() => {
      AppState.currentState = 'background';
      onState('background');
    });
    expect(setRuntimeMonitoringState).toHaveBeenLastCalledWith(false, false, false, 'power-saving', true, 0);
    expect(configureBackgroundMonitoring).toHaveBeenLastCalledWith(1, 1, 'power-saving', false);
  });

  test('forwards offline and restored network to Rust and applies policy to new runtimes', () => {
    act(() => mockNetworkChange(false));
    expect(setRuntimeMonitoringState).toHaveBeenLastCalledWith(true, true, false, 'continuous', false, 1);
    act(() => renderer.update(<Harness {...options} runtimeKey="replacement:ready" />));
    expect(setRuntimeMonitoringState).toHaveBeenLastCalledWith(true, true, false, 'continuous', false, 1);
    act(() => mockNetworkChange(true));
    expect(setRuntimeMonitoringState).toHaveBeenLastCalledWith(true, true, false, 'continuous', true, 2);
    act(() => mockNetworkChange(true)); // Wi-Fi to cellular: available, but a new route.
    expect(setRuntimeMonitoringState).toHaveBeenLastCalledWith(true, true, false, 'continuous', true, 3);
  });

  test('zero hosts and off are delivered to native cleanup independently of notifications', () => {
    act(() => renderer.update(
      <Harness {...options} hostCount={0} connectedHostCount={0} backgroundMonitoringMode="off" />,
    ));
    expect(configureBackgroundMonitoring).toHaveBeenLastCalledWith(0, 0, 'off', true);
  });

  test('Android monitoring opt-out does not silently change iOS reconnect policy', () => {
    Platform.OS = 'ios';
    act(() => renderer.update(<Harness {...options} backgroundMonitoringMode="off" />));
    expect(setRuntimeMonitoringState)
      .toHaveBeenLastCalledWith(true, true, false, 'continuous', true, 0);
    act(() => {
      AppState.currentState = 'background';
      onState('background');
    });
    expect(setRuntimeMonitoringState)
      .toHaveBeenLastCalledWith(false, true, false, 'continuous', true, 0);
  });

  test('rapid switches do not recreate subscriptions and unmount pauses transcript work', () => {
    act(() => {
      for (const state of ['background', 'active', 'background', 'active'] as const) {
        AppState.currentState = state;
        onState(state);
      }
    });
    expect(AppState.addEventListener).toHaveBeenCalledTimes(1);
    jest.mocked(configureBackgroundMonitoring).mockClear();
    act(() => renderer.unmount());
    expect(removeAppState).toHaveBeenCalledTimes(1);
    expect(mockRemoveNetwork).toHaveBeenCalledTimes(1);
    expect(setRuntimeMonitoringState).toHaveBeenLastCalledWith(false, false, false, 'continuous', true, 0);
    expect(configureBackgroundMonitoring).not.toHaveBeenCalled();
  });
});
