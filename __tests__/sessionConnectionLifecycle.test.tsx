import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';
import type {
  AppCoreProjection,
  HostRuntimeLifecycleEvent,
  HostRuntimeState,
} from 'react-native-whip-ssh';

import { useSessionConnectionLifecycle } from '../src/hooks/useSessionConnectionLifecycle';
import { createEmptyHerdrSnapshot as mockEmptySnapshot } from '../src/liveHostSessions';
import type { LiveRuntime } from '../src/hooks/sessionRuntimeTypes';
import type { ConnectionProfile } from '../src/types';
import { runSessionConnection, sessionConnectionPlatform } from '../src/services/sessionConnections';
import { herdrSnapshotCache } from '../src/services/herdrSnapshotCache';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native-whip-ssh', () =>
  require('./mockWhipSsh').createMockWhipSshModule(),
);
jest.mock('../src/services/sessionConnections', () => ({
  runSessionConnection: jest.fn(async () => true),
  sessionConnectionPlatform: jest.fn(() => ({})),
}));
jest.mock('../src/services/herdrSnapshotCache', () => ({
  herdrSnapshotCache: { schedule: jest.fn(), flush: jest.fn(async () => {}) },
}));
jest.mock('../src/services/knownHosts', () => ({
  hostKeyErrorHost: () => undefined,
  parseUnknownHostKey: () => null,
}));
jest.mock('../src/services/networkDiagnostics', () => ({
  networkErrorKind: () => 'Error',
  networkErrorMessage: (error: Error) => error.message,
  recordNetworkDiagnostic: jest.fn(),
}));
jest.mock('../src/services/HerdrClient', () => ({
  HerdrClient: jest.fn(() => {
    const client = {
      native: { hostState: () => mockHostState, exportOfflineCache: jest.fn() },
      connect: jest.fn(mockConnect),
      disconnect: jest.fn(async () => {
        mockNativeHosts.delete('thinker');
      }),
      detach: jest.fn(),
      terminal: { releaseAllTerminals: jest.fn() },
      setRuntimeEventHandler: jest.fn(),
      snapshotFromHostState: () => mockEmptySnapshot(),
    };
    mockClients.push(client);
    mockClientCreated();
    return client;
  }),
}));

type Client = {
  native: { hostState: () => HostRuntimeState; exportOfflineCache: jest.Mock };
  disconnect: jest.Mock;
  detach: jest.Mock;
  connect: jest.Mock;
  setRuntimeEventHandler: jest.Mock;
};
const mockClients: Client[] = [];
const mockClientCreated = jest.fn();
const mockNativeHosts = new Set<string>();
const mockConnect = jest.fn<Promise<void>, [ConnectionProfile]>();
const originalAppState = AppState.currentState;
let mockHostState: HostRuntimeState;
const profile: ConnectionProfile = {
  id: 'thinker',
  name: 'thinker',
  host: 'thinker',
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

let renderer: ReactTestRenderer;
let lifecycle: ReturnType<typeof useSessionConnectionLifecycle>;

function setup() {
  const stateRef = {
    current: { revision: 0, sessions: [] } as AppCoreProjection,
  };
  let updateProjection: ((next: AppCoreProjection) => void) | undefined;
  const runtimesRef = { current: new Map<string, LiveRuntime>() };
  let view: AppCoreProjection = { revision: 0, sessions: [] };

  // Adapter-only token stubs; native admission/replacement semantics are tested in Rust.
  let currentAttempt:
    { isCurrent: () => boolean; finish: () => boolean } | undefined;
  let connecting: string[] = [];
  const connectionOwnership = {
    beginConnection: () => {
      if (currentAttempt?.isCurrent()) return undefined;
      let active = true;
      const token = {
        isCurrent: () => active,
        finish: () => {
          const previous = active;
          active = false;
          return previous;
        },
      };
      currentAttempt = token;
      return token;
    },
    connectionPending: () => currentAttempt?.isCurrent() ?? false,
    cancelConnection: () => {
      currentAttempt?.finish();
    },
    cancelConnections: () => {
      currentAttempt?.finish();
      connecting = [];
    },
    setConnecting: (hostId: string, active: boolean) => {
      connecting = active
        ? [...new Set([...connecting, hostId])]
        : connecting.filter(id => id !== hostId);
      return connecting;
    },
  };

  const core = {
    ...connectionOwnership,
    view: () => view,
    openSession: (id: string, hostId: string, activate = true) => {
      view = {
        ...view,
        activeSessionId: activate ? id : view.activeSessionId,
        sessions: [
          {
            id,
            hostId,
            connectionStatus: 'ready',
            reconnectAttempt: 0,
            selection: {},
            agentControls: [],
            terminalRail: { terminals: [], resumeBlob: '' },
          },
        ],
      };
      return view;
    },
    attachRuntime: jest.fn(),
    detachRuntime: jest.fn(),
    selectSession: (id: string) => {
      view = { ...view, activeSessionId: id };
      return view;
    },
    setPlaceholderConnection: (id: string, status: 'connecting' | 'error') => {
      view = {
        ...view,
        sessions: view.sessions.map(session =>
          session.id === id
            ? { ...session, connectionStatus: status }
            : session,
        ),
      };
      return view;
    },
    closeSession: (id: string) => {
      view = {
        ...view,
        sessions: view.sessions.filter(session => session.id !== id),
      };
      return view;
    },
  };
  const restore = jest.fn(async () => ({
    activeTerminalId: null,
    sessions: [],
  }));
  const openSshShell = jest.fn();
  const setError = jest.fn();
  const navigate = jest.fn();
  const options = {
    state: stateRef.current,
    getState: core.view,
    runtimesRef,
    appCore: core,
    sessionProfilesRef: { current: new Map([[profile.id, profile]]) },
    commitAppCore: (next: AppCoreProjection) => {
      stateRef.current = next;
      updateProjection?.(next);
    },
    hosts: {
      getHosts: () => [profile],
      persistProfile: async () => ({ hosts: [profile], host: profile }),
      loadProfileForConnection: async () => profile,
      setError,
      closeEditor: jest.fn(),
      markDisconnected: jest.fn(),
    },
    navigation: {
      clearSessionView: jest.fn(),
      selectPane: jest.fn(),
      selectTab: navigate,
      showHerd: navigate,
      showTerminal: navigate,
    },
    security: { isKeyProtectionEnabled: () => false },
    terminals: { restore, openSshShell, remove: jest.fn() },
    clearLatency: jest.fn(),
    handleAgentStateChange: jest.fn(),
    t: (key: string) => key,
  } as unknown as Parameters<typeof useSessionConnectionLifecycle>[0];
  function Harness() {
    const [state, setState] = useState(stateRef.current);
    updateProjection = setState;
    lifecycle = useSessionConnectionLifecycle({ ...options, state });
    return null;
  }
  act(() => {
    renderer = create(<Harness />);
  });
  return {
    stateRef,
    hosts: options.hosts,
    runtimesRef,
    core,
    restore,
    openSshShell,
    setError,
    navigate,
  };
}

beforeEach(() => {
  mockClients.length = 0;
  mockClientCreated.mockReset();
  mockNativeHosts.clear();
  mockConnect.mockReset().mockImplementation(async connectedProfile => {
    mockNativeHosts.add(connectedProfile.id);
  });
  mockHostState = {} as HostRuntimeState;
  jest.mocked(herdrSnapshotCache.schedule).mockClear();
  jest.mocked(herdrSnapshotCache.flush).mockClear();
  jest.mocked(runSessionConnection).mockReset().mockResolvedValue(true);
});

test('interactive connections delegate profile, native admission and options', async () => {
  const { core } = setup();
  const controller = new AbortController();
  await act(async () => {
    expect(await lifecycle.connect(profile, { signal: controller.signal, activateSession: false })).toBe(true);
  });
  expect(runSessionConnection).toHaveBeenCalledWith(core, expect.any(Object), profile,
    { signal: controller.signal, activateSession: false }, false, undefined, false, 'terminal.sshShell');
  expect(mockConnect).not.toHaveBeenCalled();
  act(() => renderer.unmount());
});

test('saved-host connections enter the same native transaction', async () => {
  const { core } = setup();
  await act(async () => { await lifecycle.connectSavedHost(profile); });
  expect(runSessionConnection).toHaveBeenCalledWith(core, expect.any(Object), profile,
    { promptForUnknownHosts: true }, true, undefined, false, 'terminal.sshShell');
  act(() => renderer.unmount());
});

test('passes an existing physical runtime to native admission', async () => {
  const { runtimesRef } = setup();
  const runtime = { profile, client: { detach: jest.fn() } } as unknown as LiveRuntime;
  runtimesRef.current.set(profile.id, runtime);
  await act(async () => { await lifecycle.connect(profile); });
  expect(jest.mocked(runSessionConnection).mock.calls[0][5]).toBe(runtime);
  act(() => renderer.unmount());
});

test('projects native connecting changes and cancels admission on unmount', () => {
  const { core } = setup();
  const cancel = jest.spyOn(core, 'cancelConnections');
  const adapter = jest.mocked(sessionConnectionPlatform).mock.calls.at(-1)![0];
  act(() => adapter.trackConnecting([profile.id]));
  expect(lifecycle.connectingHostIds.has(profile.id)).toBe(true);
  act(() => renderer.unmount());
  expect(cancel).toHaveBeenCalled();
});
test('schedules native cache exports from fresh live updates', async () => {
  mockHostState = {
    revision: 0,
    connectionGeneration: 1,
    syncGeneration: 1,
    freshness: 'fresh',
    syncStatus: 'synced',
    needsResync: false,
    focus: {},
  };
  setup();
  await act(async () => {
    jest.mocked(runSessionConnection).mockImplementationOnce(async () => {
      const adapter = jest.mocked(sessionConnectionPlatform).mock.calls.at(-1)![0];
      const runtime = adapter.createRuntime(profile.id, profile);
      adapter.runtimesRef.current.set(profile.id, runtime);
      return true;
    });
    expect(await lifecycle.connect(profile)).toBe(true);
  });
  expect(herdrSnapshotCache.schedule).not.toHaveBeenCalled();
  expect(mockClients[0].native.exportOfflineCache).not.toHaveBeenCalled();

  const handler = mockClients[0].setRuntimeEventHandler.mock.calls[0][0] as (
    event: HostRuntimeLifecycleEvent,
  ) => void;
  await act(async () => {
    handler({
      type: 'host-state',
      state: { ...mockHostState, revision: 1 },
      agentStatusTransitions: [],
    });
  });
  expect(herdrSnapshotCache.schedule).toHaveBeenLastCalledWith(
    profile.id,
    mockClients[0].native,
  );
  expect(herdrSnapshotCache.schedule).toHaveBeenCalledTimes(1);

  await act(async () => {
    handler({
      type: 'host-state',
      state: { ...mockHostState, freshness: 'stale' },
      agentStatusTransitions: [],
    });
  });
  expect(herdrSnapshotCache.schedule).toHaveBeenCalledTimes(1);
});

test('flushes pending metadata on backgrounding and before UI detachment', async () => {
  let change!: (status: AppStateStatus) => void;
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      change = listener;
      return { remove: jest.fn() };
    });
  setup();
  await act(async () => {
    change('active');
  });
  expect(herdrSnapshotCache.flush).not.toHaveBeenCalled();
  await act(async () => {
    change('background');
  });
  expect(herdrSnapshotCache.flush).toHaveBeenCalledTimes(1);
  await act(async () => {
    renderer.unmount();
  });
  expect(herdrSnapshotCache.flush).toHaveBeenCalledTimes(2);
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  jest.useRealTimers();
  jest.restoreAllMocks();
  AppState.currentState = originalAppState;
});
