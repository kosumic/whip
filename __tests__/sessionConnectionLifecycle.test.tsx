import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { AppCoreProjection } from 'react-native-whip-ssh';

import { useSessionConnectionLifecycle } from '../src/hooks/useSessionConnectionLifecycle';
import {
  createEmptyHerdrSnapshot as mockEmptySnapshot,
  emptyLiveHostSessions,
  projectAppCoreSessions,
} from '../src/liveHostSessions';
import type { LiveRuntime } from '../src/hooks/sessionRuntimeTypes';
import type { ConnectionProfile } from '../src/types';
import { loadJumpHostConnectionProfiles } from '../src/services/hostProfiles';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native-whip-ssh', () => require('./mockWhipSsh').createMockWhipSshModule());
jest.mock('../src/services/hostProfiles', () => ({
  loadJumpHostConnectionProfiles: jest.fn(async () => []),
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
      native: { hostState: () => ({}) },
      connect: jest.fn(async (profile: ConnectionProfile) => {
        mockNativeHosts.add(profile.id);
      }),
      disconnect: jest.fn(async () => { mockNativeHosts.delete('thinker'); }),
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
  disconnect: jest.Mock;
  detach: jest.Mock;
  connect: jest.Mock;
};
const mockClients: Client[] = [];
const mockClientCreated = jest.fn();
const mockNativeHosts = new Set<string>();
const profile: ConnectionProfile = {
  id: 'thinker', name: 'thinker', host: 'thinker', port: '22', username: 'test',
  authMode: 'password', secret: 'test', passphrase: '', herdrCommand: 'herdr',
  sessionName: 'main', createdAt: '', updatedAt: '',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let renderer: ReactTestRenderer;
let lifecycle: ReturnType<typeof useSessionConnectionLifecycle>;

function setup() {
  const stateRef = { current: emptyLiveHostSessions };
  const runtimesRef = { current: new Map<string, LiveRuntime>() };
  let view: AppCoreProjection = { revision: 0, sessions: [] };
  const core = {
    view: () => view,
    openSession: (id: string, hostId: string) => {
      view = {
        ...view,
        sessions: [{
          id, hostId, connectionStatus: 'ready', reconnectAttempt: 0,
          selection: {}, terminalRail: { terminals: [] },
        }],
      };
      return view;
    },
    attachRuntime: jest.fn(),
    detachRuntime: jest.fn(),
    closeSession: (id: string) => {
      view = { ...view, sessions: view.sessions.filter(session => session.id !== id) };
      return view;
    },
  };
  const restore = jest.fn(async () => ({ activeTerminalId: null, sessions: [] }));
  const setError = jest.fn();
  const navigate = jest.fn();
  const options = {
    stateRef, runtimesRef, appCoreRef: { current: core },
    sessionProfilesRef: { current: new Map([[profile.id, profile]]) },
    commitAppCore: (next: AppCoreProjection) => {
      stateRef.current = projectAppCoreSessions(
        next, new Map([[profile.id, profile]]), stateRef.current, new Map(),
      );
    },
    restoredTerminalHostIdsRef: { current: new Set<string>() },
    hosts: {
      getHosts: () => [profile],
      persistProfile: async () => ({ hosts: [profile], host: profile }),
      loadProfileForConnection: async () => profile,
      setError, closeEditor: jest.fn(), markDisconnected: jest.fn(),
    },
    navigation: { clearSessionView: jest.fn(), selectTab: navigate, showHerd: navigate, showTerminal: navigate },
    security: { isKeyProtectionEnabled: () => false },
    terminals: { restore, remove: jest.fn() },
    clearLatency: jest.fn(),
    t: (key: string) => key,
  } as unknown as Parameters<typeof useSessionConnectionLifecycle>[0];
  function Harness() {
    lifecycle = useSessionConnectionLifecycle(options);
    return null;
  }
  act(() => { renderer = create(<Harness />); });
  return { stateRef, runtimesRef, core, restore, setError, navigate };
}

beforeEach(() => {
  mockClients.length = 0;
  mockClientCreated.mockReset();
  mockNativeHosts.clear();
  jest.mocked(loadJumpHostConnectionProfiles).mockResolvedValue([]);
});
afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
});

test('closing during terminal restoration releases SSH and cannot resurrect an orphan runtime', async () => {
  const { core, restore, runtimesRef, stateRef } = setup();
  const restoring = deferred<undefined>();
  const restored = deferred<{ activeTerminalId: null; sessions: [] }>();
  restore.mockImplementationOnce(() => {
    restoring.resolve(undefined);
    return restored.promise;
  });
  let connecting!: Promise<boolean>;
  await act(async () => {
    connecting = lifecycle.connect(profile);
    await restoring.promise;
  });
  expect(core.view().sessions).toHaveLength(1);
  await act(async () => { await lifecycle.closeHostById(profile.id); });
  await act(async () => {
    restored.resolve({ activeTerminalId: null, sessions: [] });
    await connecting;
  });

  expect(await connecting).toBe(false);
  expect(mockClients[0].disconnect).toHaveBeenCalledTimes(1);
  expect(mockNativeHosts.size).toBe(0);
  expect(runtimesRef.current.size).toBe(0);
  expect(core.view().sessions).toHaveLength(0);
  expect(stateRef.current.sessions).toHaveLength(0);
  expect(lifecycle.connectingHostIds.size).toBe(0);
});

test('opening an attached runtime reuses native ownership when the React projection is absent', async () => {
  const { stateRef, runtimesRef } = setup();
  await act(async () => { expect(await lifecycle.connect(profile)).toBe(true); });
  stateRef.current = emptyLiveHostSessions;

  await act(async () => { expect(await lifecycle.connect(profile)).toBe(true); });

  expect(mockClients[0].disconnect).not.toHaveBeenCalled();
  expect(mockClients).toHaveLength(1);
  expect(mockNativeHosts.size).toBe(1);
  expect(runtimesRef.current.size).toBe(1);
  expect(stateRef.current.sessions).toHaveLength(1);
});

test('closing during credential loading cancels the attempt before it creates SSH', async () => {
  const { runtimesRef } = setup();
  const loading = deferred<undefined>();
  const credentials = deferred<ConnectionProfile[]>();
  jest.mocked(loadJumpHostConnectionProfiles).mockImplementationOnce(() => {
    loading.resolve(undefined);
    return credentials.promise;
  });
  let connecting!: Promise<boolean>;
  await act(async () => {
    connecting = lifecycle.connect(profile);
    await loading.promise;
  });
  await act(async () => { await lifecycle.closeHostById(profile.id); });
  await act(async () => {
    credentials.resolve([]);
    expect(await connecting).toBe(false);
  });

  expect(mockClients).toHaveLength(0);
  expect(runtimesRef.current.size).toBe(0);
  expect(lifecycle.connectingHostIds.size).toBe(0);
});

test('explicit close during restoration cannot report errors over the newer connection', async () => {
  const { restore, runtimesRef, setError, navigate } = setup();
  const restoring = deferred<undefined>();
  const restored = deferred<{ activeTerminalId: null; sessions: [] }>();
  restore.mockImplementationOnce(() => {
    restoring.resolve(undefined);
    return restored.promise.then(() => { throw new Error('old restoration failed'); });
  });
  let first!: Promise<boolean>;
  await act(async () => {
    first = lifecycle.connect(profile);
    await restoring.promise;
  });
  await act(async () => { await lifecycle.closeHostById(profile.id); });
  await act(async () => { expect(await lifecycle.connect(profile)).toBe(true); });
  setError.mockClear();
  navigate.mockClear();
  await act(async () => {
    restored.resolve({ activeTerminalId: null, sessions: [] });
    expect(await first).toBe(false);
  });

  expect(runtimesRef.current.get(profile.id)?.client).toBe(mockClients[1]);
  expect(mockClients[0].disconnect).toHaveBeenCalledTimes(1);
  expect(mockClients[1].disconnect).not.toHaveBeenCalled();
  expect(setError).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});

test('a restoration failure retains native ownership so retry adopts it', async () => {
  const { restore, runtimesRef } = setup();
  restore.mockRejectedValueOnce(new Error('terminal storage unavailable'));
  await act(async () => { expect(await lifecycle.connect(profile)).toBe(false); });
  expect(mockNativeHosts.size).toBe(1);
  expect(mockClients[0].disconnect).not.toHaveBeenCalled();
  expect(mockClients[0].detach).toHaveBeenCalledTimes(1);
  expect(runtimesRef.current.size).toBe(0);
  await act(async () => { expect(await lifecycle.connect(profile)).toBe(true); });
  expect(mockNativeHosts.size).toBe(1);
});

test('closing before the queued SSH operation runs prevents native runtime creation', async () => {
  setup();
  let closing = Promise.resolve();
  mockClientCreated.mockImplementationOnce(() => {
    closing = Promise.resolve().then(() => lifecycle.close(profile.id));
  });
  await act(async () => {
    expect(await lifecycle.connect(profile)).toBe(false);
    await closing;
  });
  expect(mockClients[0].connect).not.toHaveBeenCalled();
  expect(mockNativeHosts.size).toBe(0);
});


test('unmount detaches UI and remount rebinds the existing process runtime', async () => {
  setup();
  await act(async () => { expect(await lifecycle.connect(profile)).toBe(true); });
  const original = mockClients[0];
  await act(async () => { renderer.unmount(); });
  expect(original.disconnect).not.toHaveBeenCalled();
  expect(original.detach).toHaveBeenCalledTimes(1);
  expect(mockNativeHosts.has(profile.id)).toBe(true);
  const { core } = setup();
  await act(async () => { expect(await lifecycle.connect(profile)).toBe(true); });
  expect(mockNativeHosts.size).toBe(1);
  expect(core.attachRuntime).toHaveBeenCalledTimes(1);
  expect(original.disconnect).not.toHaveBeenCalled();
  await act(async () => { await lifecycle.closeHostById(profile.id); });
  expect(mockClients[1].disconnect).toHaveBeenCalledTimes(1);
  expect(mockNativeHosts.size).toBe(0);
});
