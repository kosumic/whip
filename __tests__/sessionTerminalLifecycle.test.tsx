import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createHostRuntime,
  HerdrAgentKind,
  ReverseControlState,
  subscribeReverseControlEvents,
  type AgentControlView,
  type AppCoreProjection,
  type AppTerminalEntryProjection,
  type HostRuntimeConnection,
} from 'react-native-whip-ssh';

import { useSessionTerminalLifecycle } from '../src/hooks/useSessionTerminalLifecycle';
import { HerdrClient } from '../src/services/HerdrClient';
import { recordOperationalDiagnostic } from '../src/services/operationalDiagnostics';
import type { ConnectionProfile, PaneInfo } from '../src/types';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native-whip-ssh', () => ({
  ...require('./mockWhipSsh').createMockWhipSshModule(),
  createHostRuntime: jest.fn(),
  getHostRuntime: jest.fn(),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn() },
}));
jest.mock('../src/browser/registry', () => ({ browserRegistry: {} }));
jest.mock('../src/services/NativeTranscriptService', () => ({
  agentTranscriptService: {},
}));
jest.mock('../src/services/operationalDiagnostics', () => ({
  recordOperationalDiagnostic: jest.fn(),
  operationalErrorDetails: (error: Error) => ({ message: error.message }),
}));

const profile: ConnectionProfile = {
  id: 'host',
  name: 'Host',
  host: 'host.example.test',
  port: '22',
  username: 'test',
  authMode: 'password',
  secret: 'test',
  passphrase: '',
  herdrCommand: 'herdr',
  sessionName: 'main',
  createdAt: '',
  updatedAt: '',
};
const views: AgentControlView[] = [
  {
    terminalId: 'terminal',
    kind: HerdrAgentKind.Codex,
    reverseControl: true,
    connected: true,
    reverseControlState: ReverseControlState.Connected,
  },
];
let renderer: ReactTestRenderer;
let lifecycle: ReturnType<typeof useSessionTerminalLifecycle>;

function setup(
  client: HerdrClient,
  openPane = jest.fn(),
  terminals: AppTerminalEntryProjection[] = [],
  openWorkspace = jest.fn(),
) {
  const state: AppCoreProjection = {
    revision: 1,
    sessions: [
      {
        id: profile.id,
        hostId: profile.id,
        connectionStatus: 'connecting',
        reconnectAttempt: 0,
        selection: {},
        terminalRail: { terminals, resumeBlob: '' },
        agentControls: views,
      },
    ],
  };
  const options = {
    state,
    getState: () => state,
    appCore: {
      view: jest.fn(() => state),
      selectWorkspaceView: jest.fn(() => state),
      openWorkspace,
    },
    commitAppCore: jest.fn(),
    runtimesRef: { current: new Map([[profile.id, { client, profile }]]) },
    terminals: {
      get: () => ({ sessions: terminals, activeTerminalId: null }),
      openPane,
    },
    navigation: { selectPane: jest.fn() },
    select: jest.fn(),
    t: (key: string) => key,
  } as unknown as Parameters<typeof useSessionTerminalLifecycle>[0];
  function Harness() {
    lifecycle = useSessionTerminalLifecycle(options);
    return null;
  }
  act(() => {
    renderer = create(<Harness />);
  });
  return Object.assign(
    async () => {
      options.state = { ...state, sessions: [...state.sessions] };
      await act(async () => {
        renderer.update(<Harness />);
      });
    },
    { options },
  );
}

function nativeRuntime() {
  const runtime = {
    status: () => ({ state: 'connected' }),
    agentPreferencesJson: jest.fn(() => '{"agents":[]}'),
    restoreAgentPreferences: jest.fn(),
    setMonitoringState: jest.fn(),
    detach: jest.fn(),
  };
  jest
    .mocked(createHostRuntime)
    .mockReturnValue(runtime as unknown as HostRuntimeConnection);
  return runtime;
}

beforeEach(() => {
  jest.mocked(AsyncStorage.getItem).mockReset().mockResolvedValue(null);
  jest.mocked(AsyncStorage.setItem).mockReset().mockResolvedValue(undefined);
  jest.mocked(recordOperationalDiagnostic).mockClear();
});
afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
});

test('startup skips an unattached client and restores preferences once it attaches', async () => {
  const client = new HerdrClient();
  nativeRuntime();
  const update = setup(client);
  expect(AsyncStorage.getItem).not.toHaveBeenCalled();

  await client.connect(profile);
  await update();
  expect(AsyncStorage.getItem).toHaveBeenCalledWith(
    'whip.agent.preferences.v1.host',
  );
  expect(update.options.commitAppCore).toHaveBeenCalledWith(
    update.options.state,
  );
  expect(update.options.state.sessions[0].agentControls).toBe(views);
  jest.mocked(update.options.commitAppCore).mockClear();
  await update();
  expect(update.options.commitAppCore).not.toHaveBeenCalled();
});

test('cached terminals can be selected before SSH attaches without creating render targets or sending focus commands', () => {
  const client = new HerdrClient();
  const openPane = jest.fn();
  setup(client, openPane, [
    {
      terminalId: 'terminal',
      paneId: 'pane',
      title: 'Cached',
      kind: 'herdr',
      status: 'disconnected',
      reconnectAttempt: 0,
    },
  ]);
  const pane = { pane_id: 'pane', terminal_id: 'terminal' } as PaneInfo;
  expect(lifecycle.terminalTargets).toEqual([]);
  act(() => lifecycle.openPaneTerminal(profile.id, pane, true));
  expect(openPane).toHaveBeenCalledWith(profile.id, pane);
  expect(client.activeNative).toBeNull();
});

test('opening a workspace displays the native-selected pane before SSH attaches', async () => {
  const client = new HerdrClient();
  const pane = {
    pane_id: 'native-pane',
    terminal_id: 'native-terminal',
    workspace_id: 'workspace',
    tab_id: 'native-tab',
  };
  const openWorkspace = jest.fn().mockResolvedValue(pane);
  const openPane = jest.fn();
  setup(client, openPane, [], openWorkspace);
  await act(async () => {
    await lifecycle.openWorkspace(profile.id, 'workspace');
  });
  expect(openWorkspace).toHaveBeenCalledWith(profile.id, 'workspace');
  expect(openPane).toHaveBeenCalledWith(profile.id, pane);
});

test('an empty native workspace shows the localized error without opening a terminal', async () => {
  const client = new HerdrClient();
  const openPane = jest.fn();
  setup(client, openPane, [], jest.fn().mockResolvedValue(undefined));
  await act(async () => {
    await expect(
      lifecycle.openWorkspace(profile.id, 'workspace'),
    ).rejects.toThrow('session.emptyWorkspace');
  });
  expect(openPane).not.toHaveBeenCalled();
});

test('detaching during preference restoration does not publish or save a stale runtime', async () => {
  let finishLoad!: (value: null) => void;
  jest.mocked(AsyncStorage.getItem).mockReturnValue(
    new Promise(resolve => {
      finishLoad = resolve;
    }),
  );
  const client = new HerdrClient();
  const runtime = nativeRuntime();
  await client.connect(profile);
  const update = setup(client);
  await act(async () => {
    await Promise.resolve();
  });

  client.detach();
  await act(async () => {
    finishLoad(null);
  });
  expect(update.options.commitAppCore).not.toHaveBeenCalled();
  expect(runtime.agentPreferencesJson).not.toHaveBeenCalled();
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  expect(recordOperationalDiagnostic).not.toHaveBeenCalled();
});

test('Copy forwards the optional name to the native runtime and opens the created pane', async () => {
  const client = new HerdrClient();
  const runtime = nativeRuntime();
  const copyAgent = jest.fn().mockResolvedValue({
    tab: { tab_id: 'copy-tab' },
    root_pane: { pane_id: 'copy-pane', terminal_id: 'copy-terminal' },
  });
  Object.assign(runtime, { copyAgent });
  await client.connect(profile);
  const openPane = jest.fn();
  setup(client, openPane);
  await act(async () => {
    await lifecycle.copyAgent(profile.id, 'terminal', 'My copy');
  });
  expect(copyAgent).toHaveBeenCalledWith('terminal', 'My copy');
  expect(openPane).toHaveBeenCalledWith(profile.id, {
    pane_id: 'copy-pane',
    terminal_id: 'copy-terminal',
  });
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(
    'whip.agent.preferences.v1.host',
    '{"agents":[]}',
  );
});

test('reverse-control lifecycle events refresh the AppCore projection only for the attached runtime', async () => {
  const client = new HerdrClient();
  const runtime = nativeRuntime();
  await client.connect(profile);
  const update = setup(client);
  await update();
  jest.mocked(update.options.commitAppCore).mockClear();
  const listener = jest
    .mocked(subscribeReverseControlEvents)
    .mock.calls.at(-1)![0];
  const session = {
    runtimeId: profile.id,
    sessionId: 'mcp',
    paneId: 'pane',
    terminalId: 'terminal',
  };
  const event = {
    session,
    kind: 'state-changed',
    requestId: '',
    action: '',
    argumentsJson: 'null',
  };
  act(() => listener(event, runtime as unknown as HostRuntimeConnection));
  expect(update.options.commitAppCore).toHaveBeenCalledWith(
    update.options.state,
  );
  jest.mocked(update.options.commitAppCore).mockClear();
  act(() =>
    listener(
      { ...event, kind: 'action' },
      runtime as unknown as HostRuntimeConnection,
    ),
  );
  expect(update.options.commitAppCore).not.toHaveBeenCalled();
  client.detach();
  act(() => listener(event, runtime as unknown as HostRuntimeConnection));
  expect(update.options.commitAppCore).not.toHaveBeenCalled();
});
