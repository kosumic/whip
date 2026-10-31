import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useSessionStartupRestore } from '../src/hooks/useSessionStartupRestore';
import type { SessionRestorePlatform } from 'react-native-whip-ssh';
import { loadConnectionProfile } from '../src/services/hostProfiles';
import { hydrateHerdrSocketPathCache } from '../src/services/herdrSocketPathStorage';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native-whip-ssh', () => ({
  ...jest.requireActual('./mockWhipSsh').createMockWhipSshModule(),
  SessionRestoreError: {
    Failed: class extends Error {
      inner: { message: string };
      constructor(inner: { message: string }) {
        super(inner.message);
        this.inner = inner;
      }
    },
  },
}));
jest.mock('../src/services/hostProfiles', () => ({
  loadConnectionProfile: jest.fn(),
}));
jest.mock('../src/services/herdrSocketPathStorage', () => ({
  hydrateHerdrSocketPathCache: jest.fn().mockResolvedValue(undefined),
  loadHerdrSocketPathCache: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/performanceTrace', () => ({
  withAppPerformanceTrace: (_name: string, effect: () => unknown) =>
    Promise.resolve().then(effect),
}));
const profile = {
  id: 'host',
  name: 'Host',
  host: 'host.test',
  authMode: 'key',
  jumpHostId: 'jump',
};
let root: ReactTestRenderer;
function setup() {
  let complete!: () => void;
  let ready = false;
  let platform!: SessionRestorePlatform;
  const projection = { revision: 1, sessions: [] };
  const core = {
    view: () => projection,
    cancelSessionRestore: jest.fn(),
    restoreSessions: jest.fn(
      (options: { platform: SessionRestorePlatform }) => {
        platform = options.platform;
        return new Promise(resolve => {
          complete = () => resolve(projection);
        });
      },
    ),
  };
  const hosts = {
    profilesLoaded: true,
    knownHostsLoaded: true,
    getHosts: () => [profile],
    setError: jest.fn(),
    completeLiveHostRestore: jest.fn(),
  };
  const security = {
    isKeyProtectionEnabled: () => true,
    verifyBiometric: jest.fn().mockResolvedValue(true),
  };
  const commitAppCore = jest.fn(),
    connect = jest.fn().mockResolvedValue(true),
    showTerminal = jest.fn();
  const options = {
    startupStorage: {
      status: 'loaded',
      value: {
        liveHosts: 'opaque native membership',
        herdrSocketPaths: 'opaque socket hints',
      },
    },
    deferredHydrationReady: true,
    preferencesLoaded: true,
    terminalHistoryLoaded: true,
    reopenTerminalOnLaunch: true,
    appCore: core,
    hosts,
    security,
    commitAppCore,
    connect,
    navigation: { showTerminal },
    sessionProfilesRef: { current: new Map() },
    t: (key: string) => key,
  } as unknown as Parameters<typeof useSessionStartupRestore>[0];
  function Harness() {
    ready = useSessionStartupRestore(options);
    return null;
  }
  act(() => {
    root = create(<Harness />);
  });
  return {
    core,
    hosts,
    security,
    commitAppCore,
    connect,
    showTerminal,
    platform: () => platform,
    complete: () => complete(),
    ready: () => ready,
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(loadConnectionProfile).mockResolvedValue(profile as never);
});
afterEach(() => {
  act(() => root?.unmount());
});

test('submits opaque startup storage and metadata to the native owner', async () => {
  const f = setup();
  await act(async () => {});
  expect(f.core.restoreSessions).toHaveBeenCalledWith(
    expect.objectContaining({
      raw: 'opaque native membership',
      loaded: true,
      hosts: [profile],
      protectKeys: true,
      reopenTerminal: true,
    }),
  );
  await f.platform().prepare();
  expect(hydrateHerdrSocketPathCache).toHaveBeenCalledWith(
    'opaque socket hints',
  );
  expect(await f.platform().verifyKeys()).toBe(true);
  await act(() => f.platform().stateChanged());
  expect(f.commitAppCore).toHaveBeenCalled();
  expect(f.ready()).toBe(false);
  await act(async () => {
    f.complete();
  });
  expect(f.ready()).toBe(true);
  expect(f.hosts.completeLiveHostRestore).toHaveBeenCalledTimes(1);
});

test('passes metadata, the Rust attempt and cancellation signal into native credential preparation', async () => {
  const f = setup();
  await act(async () => {});
  const signal = new AbortController().signal;
  const attempt = { isCurrent: () => true, finish: () => true };
  expect(
    await f.platform().connectHost('host', true, attempt, { signal }),
  ).toBe(true);
  expect(f.connect).toHaveBeenCalledWith(
    profile,
    expect.objectContaining({
      signal,
      connectionAttempt: attempt,
      biometricVerified: true,
      navigate: false,
      persistProfile: false,
      activateSession: false,
      loadSavedCredential: true,
    }),
  );
  expect(loadConnectionProfile).not.toHaveBeenCalled();
});

test('a closed native attempt cannot request credentials or reconnect', async () => {
  const f = setup();
  await act(async () => {});
  const attempt = { isCurrent: () => false, finish: () => false };
  expect(await f.platform().connectHost('host', true, attempt)).toBe(false);
  expect(loadConnectionProfile).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
});
