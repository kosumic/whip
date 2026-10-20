const mockNativeVault = {
  hasLocalRecoveryKey: jest.fn(),
  encryptCredential: jest.fn(),
  decryptCredential: jest.fn(),
  unlockRecoveryKey: jest.fn(),
  clearRecoveryKey: jest.fn(),
};
let mockStoredBackups: string | null = null;

jest.mock('react-native-whip-ssh', () => require('./mockWhipSsh').createMockWhipSshModule());

jest.mock('react-native', () => {
  return {
    NativeModules: {},
    Platform: { OS: 'android' },
  };
});

jest.mock('../src/services/appStorage', () => ({
  __esModule: true,
  appStorage: {
    getItem: jest.fn(() => Promise.resolve(mockStoredBackups)),
    setItem: jest.fn((_key: string, value: string) => {
      mockStoredBackups = value;
      return Promise.resolve();
    }),
  },
}));

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WhenUnlockedThisDeviceOnly' },
  setGenericPassword: jest.fn(() => Promise.resolve(true)),
}));

import { appStorage } from '../src/services/appStorage';
import * as Keychain from 'react-native-keychain';
import { NativeModules } from 'react-native';
import {
  backupCredential,
  credentialRecoveryStatus,
  ensureCredentialBackup,
  recoverCredentialForHost,
  removeCredentialBackup,
  restoreCredentialBackups,
} from '../src/services/credentialVault';
import type { HostProfile } from '../src/types';

const host: HostProfile = {
  id: 'host-1',
  name: 'Savior',
  host: 'savior',
  port: '22',
  username: 'kosumi',
  authMode: 'key',
  herdrCommand: 'herdr',
  sessionName: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  NativeModules.HerdrCredentialVault = mockNativeVault;
  mockStoredBackups = null;
  jest.clearAllMocks();
  mockNativeVault.hasLocalRecoveryKey.mockResolvedValue(true);
  mockNativeVault.encryptCredential.mockResolvedValue('v1.iv.ciphertext');
  mockNativeVault.decryptCredential.mockResolvedValue(JSON.stringify({
    secret: 'PRIVATE KEY',
    passphrase: 'key phrase',
  }));
  mockNativeVault.unlockRecoveryKey.mockResolvedValue(true);
  mockNativeVault.clearRecoveryKey.mockResolvedValue(undefined);
});

test('stores only native-encrypted credential backup text in appStorage', async () => {
  await expect(backupCredential(host.id, {
    secret: 'PRIVATE KEY',
    passphrase: 'key phrase',
  })).resolves.toBe(true);

  expect(mockNativeVault.encryptCredential).toHaveBeenCalledWith(
    JSON.stringify({ secret: 'PRIVATE KEY', passphrase: 'key phrase' }),
    host.id,
  );
  expect(appStorage.setItem).toHaveBeenCalledWith(
    'herdr.credential.backups.v1',
    JSON.stringify({ [host.id]: 'v1.iv.ciphertext' }),
  );
  expect(mockStoredBackups).not.toContain('PRIVATE KEY');
  expect(mockStoredBackups).not.toContain('key phrase');
});

test('reports restored credential backups as locked when the local key was uninstalled', async () => {
  mockStoredBackups = JSON.stringify({ [host.id]: 'v1.iv.ciphertext' });
  mockNativeVault.hasLocalRecoveryKey.mockResolvedValue(false);

  await expect(credentialRecoveryStatus()).resolves.toEqual({ state: 'locked', count: 1 });
});

test('does not re-encrypt a credential that already has a recovery backup', async () => {
  mockStoredBackups = JSON.stringify({ [host.id]: 'v1.iv.ciphertext' });

  await expect(ensureCredentialBackup(host.id, {
    secret: 'PRIVATE KEY',
    passphrase: 'key phrase',
  })).resolves.toBe(true);

  expect(mockNativeVault.encryptCredential).not.toHaveBeenCalled();
});

test('unlocks, decrypts, and reimports restored credentials into Keychain', async () => {
  mockStoredBackups = JSON.stringify({ [host.id]: 'v1.iv.ciphertext' });

  await expect(restoreCredentialBackups([host])).resolves.toEqual({ restored: 1, failed: 0 });

  expect(mockNativeVault.unlockRecoveryKey).toHaveBeenCalledTimes(1);
  expect(mockNativeVault.decryptCredential).toHaveBeenCalledWith('v1.iv.ciphertext', host.id);
  expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
    host.username,
    JSON.stringify({ secret: 'PRIVATE KEY', passphrase: 'key phrase' }),
    {
      accessible: 'WhenUnlockedThisDeviceOnly',
      service: 'io.github.kaminarios.whip.ssh.host.host-1',
    },
  );
});

test('clears the Block Store recovery key after the final backup is removed', async () => {
  mockStoredBackups = JSON.stringify({ [host.id]: 'v1.iv.ciphertext' });

  await removeCredentialBackup(host.id);

  expect(mockStoredBackups).toBe('{}');
  expect(mockNativeVault.clearRecoveryKey).toHaveBeenCalledTimes(1);
});

test('blocks backup mutation when the existing backup store is corrupted', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  mockStoredBackups = '{corrupted backup storage';

  await expect(backupCredential(host.id, {
    secret: 'PRIVATE KEY',
    passphrase: 'key phrase',
  })).resolves.toBe(false);

  expect(mockNativeVault.encryptCredential).not.toHaveBeenCalled();
  expect(appStorage.setItem).not.toHaveBeenCalled();
  expect(String(consoleError.mock.calls[0]?.[0])).toContain('storage-parse-failed');
  expect(String(consoleError.mock.calls[0]?.[0])).not.toContain('corrupted backup storage');
  consoleError.mockRestore();
});

test('diagnoses credential backup encryption failures without logging credential material', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  mockNativeVault.encryptCredential.mockRejectedValueOnce(new Error('native encryption unavailable'));

  await expect(backupCredential(host.id, {
    secret: 'PRIVATE KEY',
    passphrase: 'key phrase',
  })).resolves.toBe(false);

  const diagnostic = String(consoleError.mock.calls[0]?.[0]);
  expect(diagnostic).toContain('credential-backup-encrypt-failed');
  expect(diagnostic).not.toContain('PRIVATE KEY');
  expect(diagnostic).not.toContain('key phrase');
  consoleError.mockRestore();
});

test('diagnoses credential backup write failures', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  jest.mocked(appStorage.setItem).mockRejectedValueOnce(new Error('storage unavailable'));

  await expect(backupCredential(host.id, {
    secret: 'PRIVATE KEY',
    passphrase: 'key phrase',
  })).resolves.toBe(false);

  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('storage-write-failed'));
  consoleError.mockRestore();
});

test('keeps missing recovery backups quiet', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();

  await expect(recoverCredentialForHost(host)).resolves.toBeNull();

  expect(consoleError).not.toHaveBeenCalled();
  consoleError.mockRestore();
});
