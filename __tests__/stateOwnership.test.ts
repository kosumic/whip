jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { setItem: jest.fn() },
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
jest.mock('../src/services/terminalBackground', () => ({}));
jest.mock('../src/services/appBackground', () => ({}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  clearLiveHostLatency,
  recordLiveHostLatency,
  type LiveHostTelemetryState,
} from '../src/hooks/useLiveHostTelemetry';
import { shouldPersistDevicePreferences } from '../src/hooks/useDevicePreferences';
import { PersistedTerminalsWriter } from '../src/services/persistedTerminals';
import {
  persistedLiveHostsFromSessions,
  persistedLiveHostsIdentity,
} from '../src/services/persistedLiveHosts';
import type { AppSessionProjection } from 'react-native-whip-ssh';
import type { HostProfile } from '../src/types';

beforeEach(() => {
  jest.clearAllMocks();
});

test('latency changes do not persist an unchanged opaque terminal resume', async () => {
  const writer = new PersistedTerminalsWriter();
  const blob = 'native resume';
  const fonts = new Map<string, number>();
  await writer.saveIfChanged('session-1', 'host-1', blob, fonts);
  jest.mocked(AsyncStorage.setItem).mockClear();
  const initial: LiveHostTelemetryState = new Map();
  const measured = recordLiveHostLatency(initial, 'session-1', 42);
  expect(clearLiveHostLatency(measured, 'session-1')).not.toBe(measured);
  await expect(writer.saveIfChanged('session-1', 'host-1', blob, fonts)).resolves.toBe(false);
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});

test('preferences cannot persist while loading, failed, or merely hydrated', () => {
  expect(shouldPersistDevicePreferences({ status: 'loading' }, 1)).toBe(false);
  expect(
    shouldPersistDevicePreferences(
      { status: 'failed', error: new Error('I/O') },
      2,
    ),
  ).toBe(false);
  expect(shouldPersistDevicePreferences({ status: 'loaded' }, 0)).toBe(false);
  expect(shouldPersistDevicePreferences({ status: 'loaded' }, 1)).toBe(true);
});

test('volatile host projection changes keep the durable live-host identity stable', () => {
  const host: HostProfile = {
    id: 'host-1',
    name: 'Host 1',
    host: 'host-1.example.test',
    port: '22',
    username: 'herdr',
    authMode: 'key',
    herdrCommand: 'herdr',
    sessionName: 'main',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const session = liveSessionFixture(host, 'session-1');
  const first = {
    revision: 1,
    activeSessionId: 'session-1',
    sessions: [session],
  };
  const hostStateChanged = {
    ...first,
    sessions: [
      {
        ...session,
        hostState: { revision: 2, syncStatus: 'synced' as const, freshness: 'fresh' as const, connectionGeneration: 1, syncGeneration: 1, focus: {}, needsResync: false },
      },
    ],
  };

  expect(
    persistedLiveHostsIdentity(
      persistedLiveHostsFromSessions(hostStateChanged),
    ),
  ).toBe(persistedLiveHostsIdentity(persistedLiveHostsFromSessions(first)));
});

function liveSessionFixture(
  host: HostProfile,
  id: string,
): AppSessionProjection {
  return {
    id,
    hostId: host.id,
    connectionStatus: 'connecting',
    reconnectAttempt: 0,
    selection: {}, agentControls: [], terminalRail: { terminals: [], resumeBlob: '' },
  };
}
