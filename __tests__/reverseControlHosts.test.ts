jest.mock('../packages/react-native-whip-ssh/src/generated/whip_ssh-ffi', () => ({
  __esModule: true, default: () => ({}),
}));
jest.mock('react-native-whip-ssh', () => {
  const native = jest.requireActual('../packages/react-native-whip-ssh/src/generated/whip_ssh');
  return {
    ...native,
    HostActionCoordinator: jest.fn(),
    toNativeHostProfileRecord: (host: { authMode: string }) => ({
      ...host, authMode: host.authMode === 'key' ? native.HostAuthMode.Key : native.HostAuthMode.Password,
    }),
    fromNativeHostProfileRecord: (host: { authMode: number }) => ({
      ...host, authMode: host.authMode === native.HostAuthMode.Key ? 'key' : 'password',
    }),
  };
});

import {
  AppConnectionStatus,
  HostActionCoordinator,
  HostActionPlatformError,
  HostAuthMode,
  toNativeHostProfileRecord,
  type HostActionPermitLike,
  type HostActionPlatform,
  type HostActionProfilePatch,
} from 'react-native-whip-ssh';
import { ReverseControlHosts, type HostControlContext } from '../src/services/reverseControlHosts';
import type { HostProfile } from '../src/types';

const host = {
  id: 'mini', name: 'Mini', host: 'mini.local', port: '22', username: 'kosumi',
  authMode: 'key', herdrCommand: 'herdr', herdrEnabled: true, sessionName: '',
  herdrSocketPath: '', forwardAgent: false, createdAt: '', updatedAt: '',
  agentInstructions: '# Mini\nUse system Xcode.\n',
} satisfies HostProfile;
const patch: HostActionProfilePatch = {
  name: undefined, host: undefined, port: undefined, username: undefined,
  authMode: undefined, herdrCommand: undefined, herdrSocketPath: undefined,
  sessionName: undefined, forwardAgent: undefined, jumpHostId: undefined,
  jumpHostChanged: false,
};
function permit(id = 'native-operation-a') {
  return {
    operationId: jest.fn(() => id),
    checkActive: jest.fn(),
  } satisfies HostActionPermitLike;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function setup() {
  const context: HostControlContext = {
    ready: true, locked: false, biometricForKeys: true,
    globalInstructions: '# Global\nUse Nix.\n',
    getHosts: () => [host], connections: () => [{ host_id: host.id, status: 'ready' }],
    authenticate: jest.fn(async () => true),
    saveMetadata: jest.fn(async () => ({ host })),
    readCredential: jest.fn(async () => ({ ...host, secret: 'private-key', passphrase: '' })),
    connect: jest.fn(async () => true),
    deleteTranscripts: jest.fn(async () => undefined),
    deleteSnapshot: jest.fn(async () => undefined),
    deleteProfile: jest.fn(async () => undefined),
    disconnect: jest.fn(async () => undefined),
  };
  let platform!: HostActionPlatform;
  const native = { updateContext: jest.fn(), close: jest.fn() };
  jest.mocked(HostActionCoordinator).mockImplementation(value => {
    platform = value;
    return native as unknown as HostActionCoordinator;
  });
  const bridge = new ReverseControlHosts(() => context);
  return { context, native, platform, bridge };
}

beforeEach(() => { jest.clearAllMocks(); });

test('publishes typed readiness, lock policy, host metadata and native connection status', () => {
  const { context, bridge, native } = setup();
  bridge.updateContext();
  expect(native.updateContext).toHaveBeenLastCalledWith({
    ready: true, locked: false, biometricForKeys: true,
    globalInstructions: context.globalInstructions,
    hosts: [toNativeHostProfileRecord(host)],
    connections: [{ hostId: host.id, status: AppConnectionStatus.Ready }],
  });
  context.locked = true;
  bridge.updateContext();
  expect(native.updateContext.mock.calls.at(-1)![0].locked).toBe(true);
  expect(JSON.stringify(native.updateContext.mock.calls)).not.toContain('private-key');
});

test('executes only the native-requested biometric effect', async () => {
  const { context, platform } = setup();
  expect(await platform.authenticate(permit())).toBe(true);
  expect(context.authenticate).toHaveBeenCalledTimes(1);
  expect(context.readCredential).not.toHaveBeenCalled();
  expect(context.connect).not.toHaveBeenCalled();
});

test('metadata mapping preserves omitted fields and explicit jump-host removal', async () => {
  const { context, platform } = setup();
  const current = permit();
  await platform.saveMetadata(current, host.id, { ...patch, name: 'Build', jumpHostChanged: true }, 'source');
  expect(context.saveMetadata).toHaveBeenCalledWith(host.id, { name: 'Build', jumpHostId: null }, 'source', current);
  const assertActive = jest.mocked(context.saveMetadata).mock.calls[0][3];
  assertActive.checkActive();
  expect(current.checkActive).toHaveBeenCalled();
  await platform.saveMetadata(current, host.id, { ...patch, authMode: HostAuthMode.Password }, undefined);
  expect(context.saveMetadata).toHaveBeenLastCalledWith(host.id, { authMode: 'password' }, undefined, current);
});

test('returns credentials only through the private typed credential callback', async () => {
  const { context, platform } = setup();
  const current = permit();
  const result = await platform.readCredential(current, toNativeHostProfileRecord(host));
  expect(context.readCredential).toHaveBeenCalledWith(host, current);
  expect(result).toMatchObject({ secret: 'private-key', passphrase: '' });
  expect(context.saveMetadata).not.toHaveBeenCalled();
});

test('native cancellation aborts only its owning connection effect', async () => {
  const { context, platform } = setup();
  const pending = deferred<boolean>();
  const signals: AbortSignal[] = [];
  context.connect = jest.fn((_profile, signal) => { signals.push(signal); return pending.promise; });
  const credential = { secret: 'private-key', passphrase: '' };
  const first = platform.connect(permit('a'), toNativeHostProfileRecord(host), credential);
  const second = platform.connect(permit('b'), toNativeHostProfileRecord(host), credential);
  platform.cancel('a');
  expect(signals[0].aborted).toBe(true);
  expect(signals[1].aborted).toBe(false);
  pending.resolve(true);
  await Promise.all([first, second]);
  expect(context.connect).toHaveBeenCalledWith({ ...host, ...credential }, expect.any(AbortSignal));
});

test('does not begin a platform effect when its native permit was revoked', async () => {
  const { context, platform } = setup();
  const current = permit();
  jest.mocked(current.checkActive).mockImplementation(() => { throw new Error('revoked'); });
  await expect(platform.deleteTranscripts(current, host.id)).rejects.toBeInstanceOf(HostActionPlatformError.Unavailable);
  expect(context.deleteTranscripts).not.toHaveBeenCalled();
});

test('a native permit invalidated during an asynchronous effect rejects its late result', async () => {
  const { context, platform } = setup();
  const pending = deferred<{ host: HostProfile }>();
  context.saveMetadata = jest.fn(() => pending.promise);
  const current = permit();
  const result = platform.saveMetadata(current, host.id, patch, undefined);
  jest.mocked(current.checkActive).mockImplementation(() => { throw new Error('revoked'); });
  pending.resolve({ host });
  await expect(result).rejects.toBeInstanceOf(HostActionPlatformError.Unavailable);
});

test('storage failures have a bounded typed error rather than reflecting secret payloads', async () => {
  const { context, platform } = setup();
  context.readCredential = jest.fn(async () => { throw new Error('private-key-payload'); });
  try {
    await platform.readCredential(permit(), toNativeHostProfileRecord(host));
    throw new Error('Expected callback failure');
  } catch (error) {
    expect(error).toBeInstanceOf(HostActionPlatformError.Unavailable);
    expect(String(error)).not.toContain('private-key-payload');
  }
});

test('each delete callback executes one primitive and forwards the native storage fence', async () => {
  const { context, platform } = setup();
  const current = permit();
  await platform.deleteSnapshot(current, host.id);
  expect(context.deleteSnapshot).toHaveBeenCalledWith(host.id);
  expect(context.deleteProfile).not.toHaveBeenCalled();
  expect(context.disconnect).not.toHaveBeenCalled();
  await platform.deleteProfile(current, host.id);
  expect(context.deleteProfile).toHaveBeenCalledWith(host.id, current);
  await platform.disconnect(current, host.id, false);
  expect(context.disconnect).toHaveBeenCalledWith(host.id, false);
});

test('disposal closes the native coordinator', () => {
  const { bridge, native } = setup();
  bridge.dispose();
  expect(native.close).toHaveBeenCalledTimes(1);
});

test('disposal releases live connection handles before the JS adapter is collected', async () => {
  const { bridge, context, platform } = setup();
  const pending = deferred<boolean>();
  let signal!: AbortSignal;
  context.connect = jest.fn((_profile, current) => { signal = current; return pending.promise; });
  const result = platform.connect(permit(), toNativeHostProfileRecord(host), { secret: 'private', passphrase: '' });
  bridge.dispose();
  expect(signal.aborted).toBe(true);
  pending.resolve(false);
  await result;
});
