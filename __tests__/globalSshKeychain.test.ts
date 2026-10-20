import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

import {
  GLOBAL_SSH_KEYCHAIN_SERVICE,
  deleteGlobalSshKey,
  loadGlobalSshKeys,
  saveGlobalSshKey,
  unlockGlobalSshKeychain,
} from '../src/services/globalSshKeychain';
import { authenticateGlobalKeychain } from '../src/services/appAuthentication';
import type { GlobalSshKeyMaterial } from '../src/types';

let mockStoredMetadata: string | null = null;
let mockStoredCredential: { username: string; password: string } | false = false;

jest.mock('react-native-whip-ssh', () => require('./mockWhipSsh').createMockWhipSshModule());

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => Promise.resolve(mockStoredMetadata)),
    setItem: jest.fn((_key: string, value: string) => {
      mockStoredMetadata = value;
      return Promise.resolve();
    }),
  },
}));

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only' },
  getGenericPassword: jest.fn(() => Promise.resolve(mockStoredCredential)),
  setGenericPassword: jest.fn((username: string, password: string) => {
    mockStoredCredential = { username, password };
    return Promise.resolve(true);
  }),
  resetGenericPassword: jest.fn(() => {
    mockStoredCredential = false;
    return Promise.resolve(true);
  }),
}));

jest.mock('../src/services/appAuthentication', () => ({
  authenticateGlobalKeychain: jest.fn(() => Promise.resolve()),
}));

const savedKey: GlobalSshKeyMaterial = {
  id: 'key-1',
  name: 'Personal laptop',
  fingerprint: 'SHA256:abc',
  keyType: 'ssh-ed25519',
  secret: 'PRIVATE KEY',
  passphrase: 'key phrase',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  mockStoredMetadata = null;
  mockStoredCredential = false;
  jest.clearAllMocks();
});

test('stores private key material only in the device credential store', async () => {
  const result = await saveGlobalSshKey([], {
    name: savedKey.name,
    fingerprint: savedKey.fingerprint,
    keyType: savedKey.keyType,
    secret: savedKey.secret,
    passphrase: savedKey.passphrase,
  });

  expect(result).toHaveLength(1);
  expect(result[0].id).toMatch(
    /^key-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
    'global-ssh-keychain',
    expect.stringContaining('PRIVATE KEY'),
    {
      accessible: 'when-unlocked-this-device-only',
      service: GLOBAL_SSH_KEYCHAIN_SERVICE,
    },
  );
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(
    'herdr.global-ssh-keys.v1',
    expect.any(String),
  );
  expect(mockStoredMetadata).not.toContain('PRIVATE KEY');
  expect(mockStoredMetadata).not.toContain('key phrase');
});

test('joins safe metadata with private material only after the keychain is opened', async () => {
  const metadata = {
    id: savedKey.id,
    name: savedKey.name,
    fingerprint: savedKey.fingerprint,
    keyType: savedKey.keyType,
    createdAt: savedKey.createdAt,
    updatedAt: savedKey.updatedAt,
  };
  mockStoredMetadata = JSON.stringify([metadata]);
  mockStoredCredential = {
    username: 'global-ssh-keychain',
    password: JSON.stringify([{ id: savedKey.id, secret: savedKey.secret, passphrase: savedKey.passphrase }]),
  };

  await expect(unlockGlobalSshKeychain()).resolves.toEqual([savedKey]);
  expect(authenticateGlobalKeychain).toHaveBeenCalledTimes(1);
  expect(Keychain.getGenericPassword).toHaveBeenCalledWith({ service: GLOBAL_SSH_KEYCHAIN_SERVICE });
});

test('removing the final global key clears both credential and metadata stores', async () => {
  await expect(deleteGlobalSshKey([savedKey], savedKey.id)).resolves.toEqual([]);

  expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({ service: GLOBAL_SSH_KEYCHAIN_SERVICE });
  expect(mockStoredMetadata).toBe('[]');
});

test('diagnoses corrupted global SSH key metadata', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  mockStoredMetadata = '{corrupted metadata';

  await expect(loadGlobalSshKeys()).rejects.toBeInstanceOf(SyntaxError);

  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('storage-parse-failed'));
  expect(String(consoleError.mock.calls[0]?.[0])).not.toContain('corrupted metadata');
  consoleError.mockRestore();
});

test('diagnoses malformed global SSH key material instead of reporting no keys', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  mockStoredMetadata = JSON.stringify([{
    id: savedKey.id,
    name: savedKey.name,
    fingerprint: savedKey.fingerprint,
    keyType: savedKey.keyType,
    createdAt: savedKey.createdAt,
    updatedAt: savedKey.updatedAt,
  }]);
  mockStoredCredential = {
    username: 'global-ssh-keychain',
    password: '{malformed material',
  };

  await expect(unlockGlobalSshKeychain()).rejects.toBeInstanceOf(SyntaxError);

  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    'global-ssh-key-material-parse-failed',
  ));
  consoleError.mockRestore();
});

test('rolls Keychain material back when metadata persistence fails', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  mockStoredCredential = {
    username: 'global-ssh-keychain',
    password: JSON.stringify([{
      id: savedKey.id,
      secret: savedKey.secret,
      passphrase: savedKey.passphrase,
    }]),
  };
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('metadata storage unavailable'));

  await expect(saveGlobalSshKey([savedKey], {
    name: 'Second key',
    fingerprint: 'SHA256:def',
    keyType: 'ssh-ed25519',
    secret: 'SECOND PRIVATE KEY',
    passphrase: '',
  })).rejects.toThrow('metadata storage unavailable');

  expect(Keychain.setGenericPassword).toHaveBeenLastCalledWith(
    'global-ssh-keychain',
    JSON.stringify([{
      id: savedKey.id,
      secret: savedKey.secret,
      passphrase: savedKey.passphrase,
    }]),
    expect.objectContaining({ service: GLOBAL_SSH_KEYCHAIN_SERVICE }),
  );
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('storage-write-failed'));
  consoleError.mockRestore();
});
