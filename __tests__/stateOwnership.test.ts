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
import {
  openWorkspaceFromProjection,
  runSemanticHerdrMutation,
  type SemanticHerdrMutation,
} from '../src/lib/sessionRuntimeActions';
import type { AppSessionProjection } from 'react-native-whip-ssh';
import type { HerdrSnapshot, HostProfile, PaneInfo } from '../src/types';

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
    selection: {}, terminalRail: { terminals: [], resumeBlob: '' },
  };
}

describe('native-owned Herdr actions', () => {
  const runtime = () => ({
    requestHerdrApi: jest.fn(async () => ({ type: 'ok' as const })),
  });

  test.each<{
    mutation: SemanticHerdrMutation;
    request: object;
  }>([
    {
      mutation: {
        type: 'rename-workspace',
        workspaceId: 'space-1',
        name: 'Renamed',
      },
      request: {
        method: 'workspace.rename',
        params: { workspace_id: 'space-1', label: 'Renamed' },
      },
    },
    {
      mutation: { type: 'close-workspace', workspaceId: 'space-1' },
      request: {
        method: 'workspace.close',
        params: { workspace_id: 'space-1' },
      },
    },
    {
      mutation: { type: 'close-tab', tabId: 'tab-1' },
      request: {
        method: 'tab.close',
        params: { tab_id: 'tab-1' },
      },
    },
  ])(
    '$mutation.type issues one semantic mutation without a snapshot refresh',
    async ({ mutation, request }) => {
      const native = runtime();

      await runSemanticHerdrMutation(native, mutation);

      expect(native.requestHerdrApi).toHaveBeenCalledTimes(1);
      expect(native.requestHerdrApi).toHaveBeenCalledWith(request);
    },
  );

  test('a populated workspace opens through the navigation-aware pane path', async () => {
    const native = runtime();
    const pane = testPane();
    const openPaneTerminal = jest.fn();
    const activatePaneTerminal = jest.fn();
    const refreshSnapshot = jest.fn(async () => null);
    const selectTerminal = jest.fn();
    const selectWorkspace = jest.fn();

    await openWorkspaceFromProjection({
      activatePaneTerminal,
      runtime: native,
      emptyWorkspaceError: () => new Error('empty'),
      openPaneTerminal,
      refreshSnapshot,
      selectTerminal,
      selectWorkspace,
      snapshot: testSnapshot(pane),
      workspaceId: pane.workspace_id,
    });

    expect(selectWorkspace).toHaveBeenCalledTimes(1);
    expect(openPaneTerminal).toHaveBeenCalledWith(pane);
    expect(native.requestHerdrApi).not.toHaveBeenCalled();
    expect(refreshSnapshot).not.toHaveBeenCalled();
    expect(selectTerminal).not.toHaveBeenCalled();
    expect(activatePaneTerminal).not.toHaveBeenCalled();
  });

  test('an initially empty workspace opens the pane from the explicit native projection', async () => {
    const native = runtime();
    const pane = testPane();
    const activatePaneTerminal = jest.fn();
    const refreshSnapshot = jest.fn(async () => testSnapshot(pane));

    await openWorkspaceFromProjection({
      activatePaneTerminal,
      runtime: native,
      emptyWorkspaceError: () => new Error('empty'),
      openPaneTerminal: jest.fn(),
      refreshSnapshot,
      selectTerminal: jest.fn(),
      selectWorkspace: jest.fn(),
      snapshot: testSnapshot(),
      workspaceId: pane.workspace_id,
    });

    expect(native.requestHerdrApi).toHaveBeenCalledWith({
      method: 'workspace.focus',
      params: { workspace_id: pane.workspace_id },
    });
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(activatePaneTerminal).toHaveBeenCalledWith(pane);
  });
});

function testPane(): PaneInfo {
  return {
    pane_id: 'pane-1',
    terminal_id: 'terminal-1',
    tab_id: 'tab-1',
    workspace_id: 'space-1',
    focused: true,
    revision: 1,
    agent_status: 'idle',
  };
}

function testSnapshot(pane?: PaneInfo): HerdrSnapshot {
  return {
    server: { running: true },
    focused_workspace_id: pane?.workspace_id ?? null,
    focused_tab_id: pane?.tab_id ?? null,
    focused_pane_id: pane?.pane_id ?? null,
    agents: [],
    workspaces: pane
      ? [
          {
            workspace_id: pane.workspace_id,
            number: 1,
            label: 'Workspace',
            focused: true,
            pane_count: 1,
            tab_count: 1,
            active_tab_id: pane.tab_id,
            agent_status: 'idle',
          },
        ]
      : [],
    tabs: pane
      ? [
          {
            tab_id: pane.tab_id,
            workspace_id: pane.workspace_id,
            number: 1,
            label: 'Tab',
            focused: true,
            pane_count: 1,
            agent_status: 'idle',
          },
        ]
      : [],
    panes: pane ? [pane] : [],
    layouts: [],
  };
}
