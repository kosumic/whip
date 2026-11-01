import { appStorage } from '../src/services/appStorage';
import { KnownHostCommand, KnownHostRepository, KnownHostRepositoryError, KnownHostRepositoryStatus, type KnownHostRepositoryView } from 'react-native-whip-ssh';
import {
  KnownHostsUnavailableError, currentKnownHostsState, deleteKnownHost, hostKeyErrorHost,
  loadKnownHosts, parseUnknownHostKey, trustKnownHost, type UnknownHostKeyChallenge,
} from '../src/services/knownHosts';
import type { KnownHost } from '../src/types';

jest.mock('../src/services/appStorage', () => ({
  appStorage: { initialize: jest.fn(), getItem: jest.fn(), setItem: jest.fn() },
}));
jest.mock('react-native-whip-ssh', () => require('./mockWhipSsh').createMockWhipSshModule());

const native = jest.mocked(KnownHostRepository).mock.results[0].value as {
  view: jest.Mock; begin: jest.Mock;
};
const knownHost: KnownHost = {
  id: 'known-host-1', host: 'mini.example', port: 2222, keyType: 'ssh-ed25519',
  publicKey: 'ssh-ed25519 AAAAFixtureKey mini', fingerprint: 'SHA256:fixture',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const challenge: UnknownHostKeyChallenge = {
  host: knownHost.host, port: knownHost.port, keyType: knownHost.keyType,
  publicKey: knownHost.publicKey, fingerprint: knownHost.fingerprint,
};
function view(overrides: Partial<KnownHostRepositoryView> = {}): KnownHostRepositoryView {
  return { status: KnownHostRepositoryStatus.Loaded, revision: 1n, generation: 1n, hosts: [knownHost], ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
let operation: { result: jest.Mock; cancel: jest.Mock };
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(appStorage.initialize).mockReset().mockResolvedValue(undefined);
  native.view.mockReset().mockReturnValue(view());
  operation = { result: jest.fn().mockResolvedValue(view()), cancel: jest.fn() };
  native.begin.mockReset().mockReturnValue(operation);
});
afterEach(() => jest.restoreAllMocks());

test('initializes legacy migration before native loading and renders the canonical native view', async () => {
  const initialization = deferred<undefined>();
  jest.mocked(appStorage.initialize).mockReturnValue(initialization.promise);
  const loading = loadKnownHosts();
  expect(native.begin).not.toHaveBeenCalled();
  initialization.resolve(undefined);
  expect(await loading).toEqual({ status: 'loaded', hosts: [knownHost] });
  expect(native.begin.mock.calls[0][0]).toBeInstanceOf(KnownHostCommand.Load);
  expect(appStorage.getItem).not.toHaveBeenCalled();
  expect(appStorage.setItem).not.toHaveBeenCalled();
});

test('failed initialization leaves the native migration/read policy authoritative', async () => {
  const diagnostics = jest.spyOn(console, 'error').mockImplementation();
  jest.mocked(appStorage.initialize).mockRejectedValue(new Error('SensitiveLegacyValue'));
  operation.result.mockRejectedValue(new KnownHostRepositoryError.StorageRead());
  native.view.mockReturnValue(view({ status: KnownHostRepositoryStatus.ReadFailed }));
  expect(await loadKnownHosts()).toEqual({ status: 'failed', error: expect.any(KnownHostRepositoryError.StorageRead) });
  expect(native.begin).toHaveBeenCalledTimes(1);
  expect(appStorage.setItem).not.toHaveBeenCalled();
  expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('SensitiveLegacyValue');
});

test('malformed native persistence produces a failed view without logging host-key material', async () => {
  const diagnostics = jest.spyOn(console, 'error').mockImplementation();
  operation.result.mockRejectedValue(new KnownHostRepositoryError.InvalidData());
  native.view.mockReturnValue(view({ status: KnownHostRepositoryStatus.InvalidData }));
  expect((await loadKnownHosts()).status).toBe('failed');
  expect(JSON.stringify(diagnostics.mock.calls)).toContain('storage-parse-failed');
  expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(knownHost.publicKey);
});

test('forwards confirmed host-key identity and OpenSSH representation unchanged to Rust', async () => {
  expect(await trustKnownHost(challenge)).toEqual([knownHost]);
  const command = native.begin.mock.calls[0][0];
  expect(command).toBeInstanceOf(KnownHostCommand.Trust);
  expect(command.inner).toEqual({ challenge });
  expect(appStorage.setItem).not.toHaveBeenCalled();
});

test('forwards revocation by record identity to Rust', async () => {
  native.view.mockReturnValue(view({ hosts: [], revision: 2n }));
  expect(await deleteKnownHost(knownHost.id)).toEqual([]);
  const command = native.begin.mock.calls[0][0];
  expect(command).toBeInstanceOf(KnownHostCommand.Revoke);
  expect(command.inner).toEqual({ id: knownHost.id });
});

test('native loading admission errors retain the existing UI unavailable error', async () => {
  operation.result.mockRejectedValue(new KnownHostRepositoryError.NotLoaded());
  await expect(trustKnownHost(challenge)).rejects.toBeInstanceOf(KnownHostsUnavailableError);
  expect(appStorage.setItem).not.toHaveBeenCalled();
});

test('overlapping calls enter the native queue immediately and delayed results read the newest projection', async () => {
  const first = deferred<KnownHostRepositoryView>();
  const second = deferred<KnownHostRepositoryView>();
  native.begin.mockReturnValueOnce({ result: () => first.promise, cancel: jest.fn() })
    .mockReturnValueOnce({ result: () => second.promise, cancel: jest.fn() });
  const trusting = trustKnownHost(challenge);
  const revoking = deleteKnownHost(knownHost.id);
  expect(native.begin).toHaveBeenCalledTimes(2);
  native.view.mockReturnValue(view({ hosts: [], revision: 3n }));
  second.resolve(view({ hosts: [], revision: 3n }));
  expect(await revoking).toEqual([]);
  first.resolve(view());
  expect(await trusting).toEqual([]);
  expect(currentKnownHostsState()).toEqual({ status: 'loaded', hosts: [] });
});

test('typed write failures reject the operation and diagnostics contain no host-key material', async () => {
  const diagnostics = jest.spyOn(console, 'error').mockImplementation();
  const failure = new KnownHostRepositoryError.StorageWrite();
  operation.result.mockRejectedValue(failure);
  await expect(deleteKnownHost(knownHost.id)).rejects.toBe(failure);
  expect(JSON.stringify(diagnostics.mock.calls)).toContain('storage-write-failed');
  expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(knownHost.publicKey);
});

test('AbortSignal cancellation reaches the native operation and its listener is removed', async () => {
  const controller = new AbortController();
  const remove = jest.spyOn(controller.signal, 'removeEventListener');
  const pending = deferred<KnownHostRepositoryView>();
  operation.result.mockReturnValue(pending.promise);
  const result = trustKnownHost(challenge, controller.signal);
  controller.abort();
  expect(operation.cancel).toHaveBeenCalledTimes(1);
  pending.reject(new KnownHostRepositoryError.Cancelled());
  await expect(result).rejects.toBeInstanceOf(KnownHostRepositoryError.Cancelled);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});

test('an already-aborted signal never admits a trust operation', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(trustKnownHost(challenge, controller.signal)).rejects.toBeInstanceOf(KnownHostRepositoryError.Cancelled);
  expect(native.begin).not.toHaveBeenCalled();
});

test('an old native owner cannot publish a stale view or fabricate a failed/empty trust snapshot', async () => {
  const diagnostics = jest.spyOn(console, 'error').mockImplementation();
  operation.result.mockRejectedValue(new KnownHostRepositoryError.Cancelled());
  native.view.mockImplementation(() => { throw new KnownHostRepositoryError.Cancelled(); });
  await expect(loadKnownHosts()).rejects.toBeInstanceOf(KnownHostRepositoryError.Cancelled);
  expect(diagnostics).not.toHaveBeenCalled();
});

test('parses typed unknown-host challenges while keeping changed keys and certificates separate', () => {
  expect(parseUnknownHostKey({ code: 'HOST_KEY_UNKNOWN', details: challenge })).toEqual(challenge);
  expect(parseUnknownHostKey('HostKey has been changed')).toBeNull();
  expect(parseUnknownHostKey({ code: 'HOST_KEY_CHANGED', details: challenge })).toBeNull();
  expect(parseUnknownHostKey({ code: 'UNSUPPORTED_HOST_CERTIFICATE' })).toBeNull();
  expect(hostKeyErrorHost({ code: 'UNSUPPORTED_HOST_CERTIFICATE' })).toBeNull();
  expect(hostKeyErrorHost({ code: 'HOST_KEY_CHANGED', details: { host: 'Jump.Example', port: 2222 } })).toBe('[Jump.Example]:2222');
});
