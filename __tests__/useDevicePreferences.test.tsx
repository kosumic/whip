import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';
import { appStorage } from '../src/services/appStorage';

import {
  useDevicePreferences,
  type DevicePreferencesController,
} from '../src/hooks/useDevicePreferences';
import {
  defaultDevicePreferences,
  DEVICE_PREFERENCES_KEY,
  type DevicePreferences,
} from '../src/services/devicePreferences';
import { DEVICE_PREFERENCES_FLUSH_INTERVAL_MS } from '../src/services/devicePreferencesPersistence';
import type { StartupStorageSnapshot } from '../src/services/startupStorage';
import type { LoadState } from '../src/hooks/useStartupStorage';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  Appearance: { setColorScheme: jest.fn() },
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: null },
}));
jest.mock('expo-localization', () => ({ useLocales: () => [] }));
jest.mock('../src/i18n', () => ({
  __esModule: true,
  default: { changeLanguage: jest.fn(() => Promise.resolve()) },
  languageForLocale: jest.fn(() => 'en'),
}));
jest.mock('../src/services/appLogs', () => ({
  setAppLogCaptureEnabled: jest.fn(),
}));
jest.mock('../src/services/latencyDiagnostics', () => ({
  setLatencyDiagnosticsEnabled: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/services/operationalDiagnostics', () => ({
  operationalErrorDetails: jest.fn(() => ({})),
  recordOperationalDiagnostic: jest.fn(),
}));
jest.mock('../src/services/appStorage', () => ({
  __esModule: true,
  appStorage: { getItem: jest.fn(), setItem: jest.fn() },
}));
jest.mock('../src/services/terminalBackground', () => ({
  migrateTerminalBackgroundImage: jest.fn(uri => Promise.resolve(uri)),
  removeTerminalBackgroundImage: jest.fn(),
}));
jest.mock('../src/services/appBackground', () => ({
  migrateAppBackgroundImage: jest.fn(uri => Promise.resolve(uri)),
  removeAppBackgroundImage: jest.fn(),
}));

const startupStorage: LoadState<StartupStorageSnapshot> = {
  status: 'loaded',
  value: {
    hosts: null,
    legacyHost: null,
    preferences: JSON.stringify({ terminalControlUsage: { up: 4 } }),
    legacyPreferences: [],
    knownHosts: null,
    liveHosts: null,
    terminalHistory: null,
    herdrSocketPaths: null,
  },
};
const mockSetItem = jest.mocked(appStorage.setItem);
let renderer: ReactTestRenderer;
let controller: DevicePreferencesController;
let renders: number;

function Harness({ storage = startupStorage }: {
  storage?: LoadState<StartupStorageSnapshot>;
}) {
  controller = useDevicePreferences(storage);
  renders += 1;
  return null;
}

function transition(state: AppStateStatus) {
  act(() => jest.mocked(AppState.addEventListener).mock.calls[0][1](state));
}

async function mount(storage = startupStorage) {
  await act(async () => {
    renderer = create(<Harness storage={storage} />);
  });
}

function savedPreferences(): DevicePreferences {
  const [key, value] = mockSetItem.mock.calls[mockSetItem.mock.calls.length - 1];
  expect(key).toBe(DEVICE_PREFERENCES_KEY);
  return JSON.parse(value) as DevicePreferences;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.spyOn(global, 'setInterval');
  jest.spyOn(global, 'clearInterval');
  mockSetItem.mockReset().mockResolvedValue();
  jest.mocked(appStorage.getItem).mockReset();
  renders = 0;
});

afterEach(async () => {
  await act(async () => renderer.unmount());
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('batches repeated key presses without rendering or writing until the periodic flush', async () => {
  await mount();
  const hydratedRenders = renders;
  const onControlUse = controller.recordTerminalControlUse;
  act(() => {
    for (let i = 0; i < 100; i += 1) {
      onControlUse('up');
      onControlUse('tab');
      onControlUse('ctrl');
    }
  });
  expect(renders).toBe(hydratedRenders);
  expect(mockSetItem).not.toHaveBeenCalled();
  await act(async () => {
    jest.advanceTimersByTime(DEVICE_PREFERENCES_FLUSH_INTERVAL_MS);
  });
  expect(renders).toBe(hydratedRenders);
  expect(mockSetItem).toHaveBeenCalledTimes(1);
  expect(savedPreferences()).toEqual({
    ...defaultDevicePreferences,
    terminalControlUsage: { up: 104, tab: 100, ctrl: 100 },
  });
  await act(async () => {
    jest.advanceTimersByTime(DEVICE_PREFERENCES_FLUSH_INTERVAL_MS);
  });
  expect(mockSetItem).toHaveBeenCalledTimes(1);
  await act(async () => renderer.update(<Harness />));
  expect(controller.value.terminalControlUsage).toEqual({ up: 104, tab: 100, ctrl: 100 });
  expect(controller.recordTerminalControlUse).toBe(onControlUse);
  expect(defaultDevicePreferences.terminalControlUsage).toEqual({});
});

test('flushes on background and unmount, and removes timers and subscriptions', async () => {
  await mount();
  controller.recordTerminalControlUse('left');
  await act(async () => transition('inactive'));
  expect(mockSetItem).toHaveBeenCalledTimes(1);
  await act(async () => transition('background'));
  expect(mockSetItem).toHaveBeenCalledTimes(1);
  controller.recordTerminalControlUse('right');
  await act(async () => renderer.unmount());
  expect(mockSetItem).toHaveBeenCalledTimes(2);
  expect(savedPreferences().terminalControlUsage).toEqual({ up: 4, left: 1, right: 1 });
  expect(jest.mocked(AppState.addEventListener).mock.results[0].value.remove).toHaveBeenCalled();
  expect(clearInterval).toHaveBeenCalledWith(jest.mocked(setInterval).mock.results[0].value);
});

test('saves settings promptly with buffered usage and serializes the latest pending settings', async () => {
  await mount();
  let finishWrite!: () => void;
  mockSetItem.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
  controller.recordTerminalControlUse('tab');
  await act(async () => controller.setPreference('appearance', 'dark'));
  expect(mockSetItem).toHaveBeenCalledTimes(1);
  expect(savedPreferences()).toEqual({
    ...defaultDevicePreferences,
    appearance: 'dark',
    terminalControlUsage: { up: 4, tab: 1 },
  });

  await act(async () => controller.setPreference('language', 'fr'));
  controller.recordTerminalControlUse('ctrl');
  await act(async () => controller.setTerminalPreferences(current => ({ ...current, fontSize: 14 })));
  await act(async () => transition('background'));
  expect(mockSetItem).toHaveBeenCalledTimes(1);
  await act(async () => finishWrite());
  expect(mockSetItem).toHaveBeenCalledTimes(2);
  expect(savedPreferences()).toEqual({
    ...defaultDevicePreferences,
    appearance: 'dark',
    language: 'fr',
    terminal: { ...defaultDevicePreferences.terminal, fontSize: 14 },
    terminalControlUsage: { up: 4, tab: 1, ctrl: 1 },
  });
});

test('keeps presses made during a slow write buffered until the next flush', async () => {
  await mount();
  let finishWrite!: () => void;
  mockSetItem.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
  controller.recordTerminalControlUse('tab');
  await act(async () => transition('background'));
  controller.recordTerminalControlUse('tab');
  await act(async () => finishWrite());
  expect(mockSetItem).toHaveBeenCalledTimes(1);
  expect(savedPreferences().terminalControlUsage).toEqual({ up: 4, tab: 1 });
  await act(async () => {
    jest.advanceTimersByTime(DEVICE_PREFERENCES_FLUSH_INTERVAL_MS);
  });
  expect(mockSetItem).toHaveBeenCalledTimes(2);
  expect(savedPreferences().terminalControlUsage).toEqual({ up: 4, tab: 2 });
});

test('retries a failed write with the latest settings and counters', async () => {
  await mount();
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  let failWrite!: (error: Error) => void;
  mockSetItem.mockImplementationOnce(() => new Promise((_resolve, reject) => { failWrite = reject; }));
  controller.recordTerminalControlUse('tab');
  await act(async () => transition('background'));
  controller.recordTerminalControlUse('tab');
  await act(async () => controller.setPreference('appearance', 'dark'));
  await act(async () => failWrite(new Error('Storage unavailable')));
  expect(mockSetItem).toHaveBeenCalledTimes(1);
  await act(async () => {
    jest.advanceTimersByTime(DEVICE_PREFERENCES_FLUSH_INTERVAL_MS);
  });
  expect(mockSetItem).toHaveBeenCalledTimes(2);
  expect(savedPreferences()).toMatchObject({
    appearance: 'dark',
    terminalControlUsage: { up: 4, tab: 2 },
  });
  consoleError.mockRestore();
});

test('retries a failed usage flush even without further presses', async () => {
  await mount();
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  mockSetItem.mockRejectedValueOnce(new Error('Storage unavailable'));
  controller.recordTerminalControlUse('left');
  await act(async () => transition('background'));
  await act(async () => {
    jest.advanceTimersByTime(DEVICE_PREFERENCES_FLUSH_INTERVAL_MS);
  });
  expect(mockSetItem).toHaveBeenCalledTimes(2);
  expect(savedPreferences().terminalControlUsage).toEqual({ up: 4, left: 1 });
  consoleError.mockRestore();
});

test('never writes defaults when preference hydration fails', async () => {
  jest.mocked(appStorage.getItem).mockRejectedValue(new Error('Storage unavailable'));
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  await mount({ status: 'failed', error: new Error('Startup unavailable') });
  expect(controller.hydration.status).toBe('failed');
  controller.recordTerminalControlUse('up');
  await act(async () => controller.setPreference('appearance', 'dark'));
  await act(async () => {
    transition('background');
    jest.advanceTimersByTime(DEVICE_PREFERENCES_FLUSH_INTERVAL_MS);
    renderer.unmount();
  });
  expect(mockSetItem).not.toHaveBeenCalled();
  consoleError.mockRestore();
});
