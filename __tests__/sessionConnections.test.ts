import {
  SessionConnectionFailureKind as Kind,
  SessionConnectionPhase as Phase,
  SessionConnectionPlatformError as PlatformError,
  SessionConnectionPresentation,
  SessionConnectionOutcome,
  type SessionConnectionPermitLike,
} from '../packages/react-native-whip-ssh/src/generated/whip_ssh';
import { runSessionConnection, sessionConnectionPlatform } from '../src/services/sessionConnections';
import { material, nativeHost } from '../src/services/credentialTransactions';
import { herdrSnapshotCache } from '../src/services/herdrSnapshotCache';
import { loadConnectionProfile } from '../src/services/hostProfiles';
import type { ConnectionProfile } from '../src/types';
import type { NativeAppCore } from 'react-native-whip-ssh';
import type { LiveRuntime } from '../src/hooks/sessionRuntimeTypes';

jest.mock('react-native-whip-ssh', () => require('./mockWhipSsh').createMockWhipSshModule());
jest.mock('../src/services/herdrSnapshotCache', () => ({ herdrSnapshotCache: { schedule: jest.fn() } }));
jest.mock('../src/services/networkDiagnostics', () => ({ recordNetworkDiagnostic: jest.fn() }));
jest.mock('../src/services/hostProfiles', () => ({ loadConnectionProfile: jest.fn() }));

const host: ConnectionProfile = { id: 'host', name: 'host', host: 'example.test', port: '22', username: 'test', authMode: 'password', secret: 'PRIVATE-MATERIAL', passphrase: '', herdrEnabled: false, herdrCommand: 'herdr', sessionName: 'main', createdAt: 'created', updatedAt: 'updated' };
const value = () => ({ host: nativeHost(host), credential: material(host) });
function lease(id = 'operation') {
  return { isCurrent: jest.fn(() => true), operationId: () => id } as unknown as SessionConnectionPermitLike & { isCurrent: jest.Mock };
}
function setup() {
  const runtime = {
    profile: host,
    client: {
      connect: jest.fn(async () => {}), disconnect: jest.fn(async () => {}), detach: jest.fn(),
      native: { connectionHandle: {}, hostState: () => ({ freshness: 'fresh' }) },
      snapshotFromHostState: jest.fn(),
    },
  };
  const options = {
    appCore: { view: jest.fn(() => ({})), connectionCore: { connectingHosts: jest.fn(() => ['current']) } }, commitAppCore: jest.fn(),
    runtimesRef: { current: new Map<string, LiveRuntime>() }, sessionProfilesRef: { current: new Map() },
    hosts: { loadProfileForConnection: jest.fn(async () => host), setError: jest.fn(), closeEditor: jest.fn(), confirmUnknownHost: jest.fn(async () => true), trustChallenge: jest.fn(async () => {}) },
    security: { verifyBiometric: jest.fn(async () => true) },
    terminals: { restore: jest.fn(async (_sessionId: string, _hostId: string, _isCurrent: () => boolean) => ({ activeTerminalId: 'terminal' })) },
    navigation: { showHerd: jest.fn(), showTerminal: jest.fn(), selectPane: jest.fn(), selectTab: jest.fn() },
    createRuntime: jest.fn(() => runtime as unknown as LiveRuntime), refresh: jest.fn(async () => {}), trackConnecting: jest.fn(),
    t: (key: string) => key,
  };
  const adapter = sessionConnectionPlatform(options as unknown as Parameters<typeof sessionConnectionPlatform>[0]);
  return { adapter, options, runtime };
}

test('credential callback delegates to the credential service and returns typed ephemeral material', async () => {
  const { adapter, options } = setup();
  await expect(adapter.loadProfile(lease(), nativeHost(host), true)).resolves.toEqual(value());
  expect(options.hosts.loadProfileForConnection).toHaveBeenCalledWith(expect.objectContaining({ id: host.id, authMode: 'password' }));
});

test('revoked callback leases cannot read credentials or create transports', async () => {
  const { adapter, options } = setup(); const permit = lease(); permit.isCurrent.mockReturnValue(false);
  await expect(adapter.loadProfile(permit, nativeHost(host), true)).rejects.toBeInstanceOf(PlatformError.Cancelled);
  await expect(adapter.connectRuntime(permit, value(), [])).rejects.toBeInstanceOf(PlatformError.Cancelled);
  expect(options.hosts.loadProfileForConnection).not.toHaveBeenCalled();
  expect(options.createRuntime).not.toHaveBeenCalled();
});

test('transport callback reuses its physical handle across a native trust retry', async () => {
  const { adapter, options, runtime } = setup(); const permit = lease();
  await adapter.connectRuntime(permit, value(), []);
  await adapter.connectRuntime(permit, value(), []);
  expect(options.createRuntime).toHaveBeenCalledTimes(1);
  expect(runtime.client.connect).toHaveBeenCalledTimes(2);
});

test('initial offline-cache publication waits for the native prepared presentation', async () => {
  const { adapter, runtime } = setup(); const permit = lease();
  jest.mocked(herdrSnapshotCache.schedule).mockClear();
  await adapter.connectRuntime(permit, value(), []);
  expect(herdrSnapshotCache.schedule).not.toHaveBeenCalled();
  adapter.present(permit, new SessionConnectionPresentation.Prepared({ host: nativeHost(host) }));
  expect(herdrSnapshotCache.schedule).toHaveBeenCalledWith(host.id, runtime.client.native);
});

test('unknown and changed host keys cross the bridge as typed challenges', async () => {
  const { adapter, runtime } = setup();
  const challenge = { host: 'jump.test', port: 22, keyType: 'ssh-ed25519', fingerprint: 'fingerprint', publicKey: 'public' };
  runtime.client.connect.mockRejectedValueOnce({ code: 'HOST_KEY_UNKNOWN', details: challenge });
  await expect(adapter.connectRuntime(lease(), value(), [])).rejects.toBeInstanceOf(PlatformError.UnknownHostKey);
  runtime.client.connect.mockRejectedValueOnce({ code: 'HOST_KEY_CHANGED', details: challenge });
  await expect(adapter.connectRuntime(lease(), value(), [])).rejects.toBeInstanceOf(PlatformError.ChangedHostKey);
});

test('biometric cancellation returns a typed outcome without exception contents', async () => {
  const { adapter, options } = setup(); options.security.verifyBiometric.mockRejectedValueOnce(new Error('PRIVATE-MATERIAL'));
  await expect(adapter.verifyKeys(lease())).rejects.toBeInstanceOf(PlatformError.Cancelled);
});

test('background credential effects read the store without opening recovery or editor UI', async () => {
  const { adapter, options } = setup();
  jest.mocked(loadConnectionProfile).mockResolvedValueOnce(host);
  await expect(adapter.loadProfile(lease(), nativeHost(host), false)).resolves.toEqual(value());
  expect(options.hosts.loadProfileForConnection).not.toHaveBeenCalled();
});

test('terminal restoration receives the native lease predicate', async () => {
  const { adapter, options } = setup(); const permit = lease();
  await expect(adapter.restoreTerminals(permit, host.id)).resolves.toBe(true);
  const isCurrent = options.terminals.restore.mock.calls[0][2];
  permit.isCurrent.mockReturnValue(false);
  expect(isCurrent()).toBe(false);
});

test('cleanup releases only the handle belonging to its transaction', async () => {
  const { adapter, options, runtime } = setup(); const permit = lease();
  await adapter.connectRuntime(permit, value(), []);
  const replacement = { profile: host } as LiveRuntime;
  options.runtimesRef.current.set(host.id, replacement);
  await adapter.cleanup(permit, host.id, false);
  expect(runtime.client.disconnect).toHaveBeenCalledTimes(1);
  expect(options.runtimesRef.current.get(host.id)).toBe(replacement);
});

test('partial UI restoration detaches the client when native policy retains SSH', async () => {
  const { adapter, runtime } = setup(); const permit = lease();
  await adapter.connectRuntime(permit, value(), []);
  await adapter.cleanup(permit, host.id, true);
  expect(runtime.client.detach).toHaveBeenCalledTimes(1);
  expect(runtime.client.disconnect).not.toHaveBeenCalled();
});

test('UI presentation maps native terminal decisions and localized failures', () => {
  const { adapter, options } = setup(); const permit = lease();
  adapter.present(permit, new SessionConnectionPresentation.Ready({ sessionId: host.id, terminal: true, navigate: true }));
  expect(options.navigation.showTerminal).toHaveBeenCalledWith(host.id);
  adapter.present(permit, new SessionConnectionPresentation.Failed({ navigate: false, failure: { phase: Phase.Transport, kind: Kind.Authentication, hostId: host.id, host: host.host, expectedProtocol: undefined, receivedProtocol: undefined } }));
  expect(options.hosts.setError).toHaveBeenCalledWith('app.connectAuthenticationError');
});

test('a delayed connecting notification projects current native admission', () => {
  const { adapter, options } = setup();
  adapter.connectingChanged(['stale']);
  expect(options.trackConnecting).toHaveBeenCalledWith(['current']);
});

test('request adapter passes the admitted startup attempt and cancellation to native', async () => {
  const cancellation = new AbortController(); const cancel = jest.fn();
  let resolve!: (value: SessionConnectionOutcome) => void;
  const result = new Promise<SessionConnectionOutcome>(done => { resolve = done; });
  const startConnection = jest.fn((_request: unknown, _credentials: unknown, _platform: unknown) => ({ result: () => result, cancel }));
  const core = { connectionCore: { startConnection } } as unknown as NativeAppCore;
  const { adapter } = setup(); const attempt = { isCurrent: () => true, finish: () => true };
  const operation = runSessionConnection(core, adapter, host, { signal: cancellation.signal, connectionAttempt: attempt, biometricVerified: true, activateSession: false }, false);
  cancellation.abort();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(startConnection.mock.calls[0][0]).toMatchObject({ attempt, biometricVerified: true, activate: false, credential: material(host) });
  resolve(new SessionConnectionOutcome.Cancelled());
  await expect(operation).resolves.toBe(false);
});

test('an already-canceled request cannot change an existing native session', async () => {
  const cancellation = new AbortController(); cancellation.abort();
  const startConnection = jest.fn();
  const core = { connectionCore: { startConnection } } as unknown as NativeAppCore;
  const { adapter } = setup();
  await expect(runSessionConnection(core, adapter, host, { signal: cancellation.signal }, false)).resolves.toBe(false);
  expect(startConnection).not.toHaveBeenCalled();
});
