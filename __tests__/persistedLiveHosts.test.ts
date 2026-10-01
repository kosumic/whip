jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn() },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AppSessionProjection } from 'react-native-whip-ssh';
import {
  loadPersistedLiveHosts,
  persistedLiveHostsFromSessions,
  persistedLiveHostsIdentity,
  savePersistedLiveHosts,
} from '../src/services/persistedLiveHosts';

const mockGetItem = jest.mocked(AsyncStorage.getItem);
const mockSetItem = jest.mocked(AsyncStorage.setItem);

beforeEach(() => {
  mockGetItem.mockReset();
  mockSetItem.mockReset();
});

test('loads only valid unique host ids and repairs the active id', async () => {
  mockGetItem.mockResolvedValue(JSON.stringify({
    hostIds: ['savior', '', 'savior', 4, 'backup'],
    activeHostId: 'missing',
  }));
  await expect(loadPersistedLiveHosts()).resolves.toEqual({
    hostIds: ['savior', 'backup'],
    activeHostId: 'savior',
  });
});

test('persists the live host rail', async () => {
  const state = { hostIds: ['savior'], activeHostId: 'savior' };
  await savePersistedLiveHosts(state);
  expect(mockSetItem).toHaveBeenCalledWith('herdr.live.hosts.v1', JSON.stringify(state));
});

test('volatile host projection changes keep the durable live-host identity stable', () => {
  const session: AppSessionProjection = {
    id: 'session-1',
    hostId: 'host-1',
    connectionStatus: 'connecting',
    reconnectAttempt: 0,
    selection: {},
    agentControls: [],
    terminalRail: { terminals: [], resumeBlob: '' },
  };
  const first = {
    revision: 1,
    activeSessionId: session.id,
    sessions: [session],
  };
  const hostStateChanged = {
    ...first,
    sessions: [
      {
        ...session,
        hostState: {
          revision: 2,
          syncStatus: 'synced' as const,
          freshness: 'fresh' as const,
          connectionGeneration: 1,
          syncGeneration: 1,
          focus: {},
          needsResync: false,
        },
      },
    ],
  };

  expect(
    persistedLiveHostsIdentity(persistedLiveHostsFromSessions(hostStateChanged)),
  ).toBe(persistedLiveHostsIdentity(persistedLiveHostsFromSessions(first)));
});

test('logs live-host read failure while preserving the empty startup fallback', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  mockGetItem.mockRejectedValueOnce(new Error('read unavailable'));

  const state = await loadPersistedLiveHosts()
    .catch(() => ({ hostIds: [], activeHostId: null }));

  expect(state).toEqual({ hostIds: [], activeHostId: null });
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '[StorageDiagnostics] storage-read-failed',
  ));
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '"store":"persisted-live-hosts"',
  ));
  consoleError.mockRestore();
});

test('logs malformed live-host JSON and keeps returning empty state', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  mockGetItem.mockResolvedValueOnce('{not json');

  await expect(loadPersistedLiveHosts()).resolves.toEqual({
    hostIds: [],
    activeHostId: null,
  });
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '[StorageDiagnostics] storage-parse-failed',
  ));
  consoleError.mockRestore();
});

test('logs live-host write rejection', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const error = new Error('write unavailable');
  mockSetItem.mockRejectedValueOnce(error);

  await expect(savePersistedLiveHosts({ hostIds: [], activeHostId: null })).rejects.toBe(error);

  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '[StorageDiagnostics] storage-write-failed',
  ));
  consoleError.mockRestore();
});
