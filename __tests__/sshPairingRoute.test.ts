import { pairHost } from 'react-native-whip-ssh';

import { pairHostWithRoute } from '../src/services/sshPairing';
import { loadJumpHostConnectionProfiles } from '../src/services/hostProfiles';
import type { ConnectionProfile } from '../src/types';

jest.mock('react-native-whip-ssh', () => ({ pairHost: jest.fn(), NativeKnownHostStore: jest.fn() }));
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: {} }));
jest.mock('../src/services/hostProfiles', () => ({ loadJumpHostConnectionProfiles: jest.fn() }));
jest.mock('../src/lib/hostProfiles', () => ({ hostDisplayName: (profile: ConnectionProfile) => profile.name }));

const result = { sshHost: 'target.internal', alreadyPresent: false };
const challenge = {
  host: 'bastion.example.test', port: 22, keyType: 'ssh-ed25519',
  publicKey: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:test',
};
const hostKeyError = { code: 'HOST_KEY_UNKNOWN', details: challenge };
const profile = {
  id: 'outer', name: 'Outer', host: ' bastion.example.test ', port: '2222',
  username: ' alice ', authMode: 'password', secret: 'password', passphrase: '',
} as ConnectionProfile;
const route = {
  hosts: [],
  onAuthenticatePrivateKey: jest.fn(async () => true),
  onConfirmUnknownHost: jest.fn(async () => true),
  onTrustHost: jest.fn(async () => {}),
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(loadJumpHostConnectionProfiles).mockResolvedValue([]);
  jest.mocked(pairHost).mockReset().mockResolvedValue(result as Awaited<ReturnType<typeof pairHost>>);
  route.onAuthenticatePrivateKey.mockResolvedValue(true);
  route.onConfirmUnknownHost.mockResolvedValue(true);
});

test('pairs directly without unlocking saved private keys', async () => {
  await expect(pairHostWithRoute('WP4:code', 'public-key', 'phone', route)).resolves.toBe(result);
  expect(pairHost).toHaveBeenCalledWith('WP4:code', 'public-key', 'phone', []);
  expect(route.onAuthenticatePrivateKey).not.toHaveBeenCalled();
});

test('passes the resolved jump chain in order and unlocks its private keys before pairing', async () => {
  const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----';
  jest.mocked(loadJumpHostConnectionProfiles).mockResolvedValue([
    profile,
    { ...profile, id: 'inner', host: 'inner.internal', authMode: 'key', secret: privateKey, passphrase: 'passphrase' },
  ]);
  await pairHostWithRoute('WP4:code', 'public-key', 'phone', { ...route, jumpHostId: 'inner' });
  expect(loadJumpHostConnectionProfiles).toHaveBeenCalledWith([], expect.objectContaining({ jumpHostId: 'inner' }));
  expect(pairHost).toHaveBeenCalledWith('WP4:code', 'public-key', 'phone', [
    { host: 'bastion.example.test', port: 2222, username: 'alice', authMode: 'password', secret: 'password' },
    { host: 'inner.internal', port: 2222, username: 'alice', authMode: 'key', secret: privateKey, passphrase: 'passphrase' },
  ]);
  expect(route.onAuthenticatePrivateKey.mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(pairHost).mock.invocationCallOrder[0]);
});

test('cancelling biometric authentication prevents network pairing', async () => {
  jest.mocked(loadJumpHostConnectionProfiles).mockResolvedValue([{ ...profile, authMode: 'key' }]);
  route.onAuthenticatePrivateKey.mockResolvedValue(false);
  await expect(pairHostWithRoute('code', 'key', 'phone', route)).resolves.toBeNull();
  expect(pairHost).not.toHaveBeenCalled();
});

test('trusts an unknown jump host only after confirmation, then retries enrollment', async () => {
  jest.mocked(loadJumpHostConnectionProfiles).mockResolvedValue([profile]);
  jest.mocked(pairHost).mockRejectedValueOnce(hostKeyError);
  await expect(pairHostWithRoute('code', 'key', 'phone', route)).resolves.toBe(result);
  expect(route.onConfirmUnknownHost).toHaveBeenCalledWith(challenge);
  expect(route.onTrustHost).toHaveBeenCalledWith(challenge);
  expect(pairHost).toHaveBeenCalledTimes(2);
});

test('declining trust stops pairing without trusting the key', async () => {
  jest.mocked(loadJumpHostConnectionProfiles).mockResolvedValue([profile]);
  jest.mocked(pairHost).mockRejectedValueOnce(hostKeyError);
  route.onConfirmUnknownHost.mockResolvedValue(false);
  await expect(pairHostWithRoute('code', 'key', 'phone', route)).resolves.toBeNull();
  expect(route.onTrustHost).not.toHaveBeenCalled();
  expect(pairHost).toHaveBeenCalledTimes(1);
});

test('a changed jump host key fails without offering to trust its replacement', async () => {
  const changed = { ...hostKeyError, code: 'HOST_KEY_CHANGED' };
  jest.mocked(pairHost).mockRejectedValueOnce(changed);
  await expect(pairHostWithRoute('code', 'key', 'phone', route)).rejects.toBe(changed);
  expect(route.onConfirmUnknownHost).not.toHaveBeenCalled();
});

test('missing jump credentials fail before enrollment', async () => {
  jest.mocked(loadJumpHostConnectionProfiles).mockResolvedValue([{ ...profile, secret: '' }]);
  await expect(pairHostWithRoute('code', 'key', 'phone', route)).rejects.toThrow('Outer needs a saved SSH credential');
  expect(pairHost).not.toHaveBeenCalled();
});
