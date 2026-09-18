import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState } from 'react-native';
import { useLiveHostMonitoring } from '../src/hooks/useLiveHostMonitoring';
import {
  startBackgroundMonitoring,
  stopBackgroundMonitoring,
} from '../src/services/backgroundMonitoring';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('../src/services/backgroundMonitoring', () => ({
  startBackgroundMonitoring: jest.fn(async () => {}),
  stopBackgroundMonitoring: jest.fn(async () => {}),
}));
jest.mock('../src/services/latencyDiagnostics', () => ({
  flushLatencyDiagnosticWrites: jest.fn(async () => {}),
}));
jest.mock('../src/services/networkDiagnostics', () => ({
  recordNetworkDiagnostic: jest.fn(),
}));

test('FGS toggle and background/unmount send policy signals without destroying a host', async () => {
  const disconnect = jest.fn();
  const setRuntimeMonitoringState = jest.fn();
  const client = { disconnect, setMonitoringState: setRuntimeMonitoringState };
  let change!: (state: string) => void;
  const remove = jest.fn();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      change = handler as typeof change;
      return { remove };
    });
  function Harness({ enabled }: { enabled: boolean }) {
    useLiveHostMonitoring({
      liveHostCount: 1,
      alertsEnabled: enabled,
      restoreComplete: true,
      hostsVisible: true,
      appAccessLocked: false,
      setRuntimeMonitoringState: client.setMonitoringState,
      onBackgroundMonitoringError: error => {
        throw error;
      },
    });
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness enabled />);
  });
  expect(startBackgroundMonitoring).toHaveBeenCalledWith(1);
  await act(async () => {
    change('background');
  });
  expect(setRuntimeMonitoringState).toHaveBeenLastCalledWith(
    false,
    true,
    false,
  );
  await act(async () => {
    renderer.update(<Harness enabled={false} />);
  });
  expect(stopBackgroundMonitoring).toHaveBeenCalledTimes(1);
  await act(async () => {
    change('active');
  });
  expect(setRuntimeMonitoringState).toHaveBeenLastCalledWith(true, true, false);
  await act(async () => {
    renderer.unmount();
  });
  expect(disconnect).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalled();
  jest.restoreAllMocks();
});
