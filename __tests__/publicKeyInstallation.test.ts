import { installHostPublicKey } from 'react-native-whip-ssh';

import { installPublicKeyForHost } from '../src/services/publicKeyInstallation';
import { loadConnectionProfile, loadJumpHostConnectionProfiles } from '../src/services/hostProfiles';
import type { ConnectionProfile } from '../src/types';

jest.mock('react-native-whip-ssh', () => ({ installHostPublicKey: jest.fn(), NativeKnownHostStore: jest.fn() }));
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: {} }));
jest.mock('../src/services/hostProfiles', () => ({ loadConnectionProfile: jest.fn(), loadJumpHostConnectionProfiles: jest.fn() }));
jest.mock('../src/lib/hostProfiles', () => ({ hostDisplayName: (profile: ConnectionProfile) => profile.name }));

const host = {
  id: 'target', name: 'Target', host: ' target.test ', port: '2222', username: ' alice ',
  authMode: 'password', secret: 'saved-password', passphrase: '', lastConnectedAt: '2026-10-19',
} as ConnectionProfile;
const key = 'ssh-ed25519 public-key';
const route = {
  hosts: [host],
  onAuthenticatePrivateKey: jest.fn(async () => true),
  onConfirmUnknownHost: jest.fn(async () => true),
  onTrustHost: jest.fn(async () => {}),
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(loadConnectionProfile).mockResolvedValue(host);
  jest.mocked(loadJumpHostConnectionProfiles).mockResolvedValue([]);
  jest.mocked(installHostPublicKey).mockResolvedValue('added');
  route.onAuthenticatePrivateKey.mockResolvedValue(true);
  route.onConfirmUnknownHost.mockResolvedValue(true);
});

test('uses saved credentials without requesting another SSH password or changing the profile', async () => {
  await expect(installPublicKeyForHost(host, key, route)).resolves.toBe('added');
  expect(loadConnectionProfile).toHaveBeenCalledWith(host);
  expect(installHostPublicKey).toHaveBeenCalledWith({
    host: 'target.test', port: 2222, username: 'alice', authMode: 'password', secret: 'saved-password',
  }, [], key);
  expect(route.onAuthenticatePrivateKey).not.toHaveBeenCalled();
});

test('refuses a never-connected host before reading credentials or opening SSH', async () => {
  await expect(installPublicKeyForHost({ ...host, lastConnectedAt: undefined }, key, route)).rejects.toThrow('Connect to this host');
  expect(loadConnectionProfile).not.toHaveBeenCalled();
  expect(installHostPublicKey).not.toHaveBeenCalled();
});

test('a first successful connection enables installation before its first disconnect', async () => {
  await expect(installPublicKeyForHost({ ...host, lastConnectedAt: undefined }, key, { ...route, connected: true })).resolves.toBe('added');
  expect(installHostPublicKey).toHaveBeenCalledTimes(1);
});

test('preserves jump-host order and authenticates access to saved private keys', async () => {
  jest.mocked(loadJumpHostConnectionProfiles).mockResolvedValue([
    { ...host, id: 'outer', host: 'outer.test', port: '22' },
    { ...host, id: 'inner', host: 'inner.test', authMode: 'key', secret: 'PRIVATE', passphrase: 'encrypted' },
  ]);
  await installPublicKeyForHost(host, key, route);
  const [, jumps] = jest.mocked(installHostPublicKey).mock.calls[0];
  expect(jumps.map(jump => jump.host)).toEqual(['outer.test', 'inner.test']);
  expect(jumps[1]).toMatchObject({ authMode: 'key', secret: 'PRIVATE', passphrase: 'encrypted' });
  expect(route.onAuthenticatePrivateKey.mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(installHostPublicKey).mock.invocationCallOrder[0]);
});

test('biometric cancellation and missing credentials stop before remote mutation', async () => {
  jest.mocked(loadConnectionProfile).mockResolvedValue({ ...host, authMode: 'key' });
  route.onAuthenticatePrivateKey.mockResolvedValue(false);
  await expect(installPublicKeyForHost(host, key, route)).resolves.toBeNull();
  jest.mocked(loadConnectionProfile).mockResolvedValue({ ...host, secret: '' });
  await expect(installPublicKeyForHost(host, key, route)).rejects.toThrow('saved SSH credential');
  expect(installHostPublicKey).not.toHaveBeenCalled();
});

const challenge = { host: 'target.test', port: 2222, keyType: 'ssh-ed25519', publicKey: 'server-key', fingerprint: 'SHA256:server' };

test('retries an unknown host only after fingerprint confirmation and trust persistence', async () => {
  jest.mocked(installHostPublicKey).mockRejectedValueOnce({ code: 'HOST_KEY_UNKNOWN', details: challenge }).mockResolvedValueOnce('already-present');
  await expect(installPublicKeyForHost(host, key, route)).resolves.toBe('already-present');
  expect(route.onConfirmUnknownHost).toHaveBeenCalledWith(challenge);
  expect(route.onTrustHost).toHaveBeenCalledWith(challenge);
  expect(installHostPublicKey).toHaveBeenCalledTimes(2);
});

test('declining trust stops the operation and changed host keys are never trusted', async () => {
  jest.mocked(installHostPublicKey).mockRejectedValueOnce({ code: 'HOST_KEY_UNKNOWN', details: challenge });
  route.onConfirmUnknownHost.mockResolvedValue(false);
  await expect(installPublicKeyForHost(host, key, route)).resolves.toBeNull();
  expect(route.onTrustHost).not.toHaveBeenCalled();
  const changed = { code: 'HOST_KEY_CHANGED', details: challenge };
  jest.mocked(installHostPublicKey).mockRejectedValueOnce(changed);
  await expect(installPublicKeyForHost(host, key, route)).rejects.toBe(changed);
  expect(route.onConfirmUnknownHost).toHaveBeenCalledTimes(1);
  expect(route.onTrustHost).not.toHaveBeenCalled();
});
