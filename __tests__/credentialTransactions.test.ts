jest.mock('react-native-whip-ssh', () => require('./mockWhipSsh').createMockWhipSshModule());
jest.mock('react-native', () => ({ NativeModules: {}, Platform: { OS: 'android' } }));
jest.mock('../src/services/appStorage', () => ({ appStorage: { getItem: jest.fn(), multiGet: jest.fn(), setItem: jest.fn(), multiSet: jest.fn() } }));
jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only' },
  getGenericPassword: jest.fn(), setGenericPassword: jest.fn(), resetGenericPassword: jest.fn(),
}));
jest.mock('../src/services/appAuthentication', () => ({ authenticateGlobalKeychain: jest.fn() }));

import * as Keychain from 'react-native-keychain';
import { NativeModules } from 'react-native';
import {
  CredentialEffect, CredentialEffectResult_Tags, CredentialPlatformError, CredentialSlot, CredentialStorageKey,
  CredentialTransactionError, type CredentialEffectPermitLike,
} from 'react-native-whip-ssh/src/credentialTransactions';
import { credentialPlatform } from '../src/services/credentialTransactions';
import { appStorage } from '../src/services/appStorage';
import { authenticateGlobalKeychain } from '../src/services/appAuthentication';

const permit = (): CredentialEffectPermitLike => ({ checkActive: jest.fn() });
const vault = { encryptCredential: jest.fn(), decryptCredential: jest.fn(), hasLocalRecoveryKey: jest.fn(), unlockRecoveryKey: jest.fn(), clearRecoveryKey: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  NativeModules.HerdrCredentialVault = vault;
  jest.mocked(Keychain.setGenericPassword).mockResolvedValue(true as never);
  jest.mocked(Keychain.resetGenericPassword).mockResolvedValue(true);
  jest.mocked(Keychain.getGenericPassword).mockResolvedValue(false);
  jest.mocked(appStorage.getItem).mockResolvedValue(null);
});

test('metadata and its journal are written as one physical database batch', async () => {
  await credentialPlatform().effect(permit(), new CredentialEffect.WriteMetadata({ entries: [
    { key: CredentialStorageKey.Hosts, value: '[]' },
    { key: CredentialStorageKey.Transactions, value: '{"version":1}' },
  ] }));
  expect(appStorage.multiSet).toHaveBeenCalledWith([
    ['herdr.hosts.v2', '[]'], ['whip.credentials.transactions.v1', '{"version":1}'],
  ]);
  expect(appStorage.setItem).not.toHaveBeenCalled();
});

test('incomplete storage snapshots become bounded metadata failures', async () => {
  jest.mocked(appStorage.multiGet).mockResolvedValueOnce([['herdr.hosts.v2', '[]']]);
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  await expect(credentialPlatform().effect(permit(), new CredentialEffect.ReadMetadata({ keys: [CredentialStorageKey.Hosts, CredentialStorageKey.LegacyProfile] })))
    .rejects.toBeInstanceOf(CredentialPlatformError.MetadataStorage);
  consoleError.mockRestore();
});

test('secure-store writes use device-only protection and the native-selected slot', async () => {
  await credentialPlatform().effect(permit(), new CredentialEffect.WriteSecure({ slot: new CredentialSlot.Host({ id: 'a' }), username: 'user', value: 'PRIVATE' }));
  expect(Keychain.setGenericPassword).toHaveBeenCalledWith('user', 'PRIVATE', { accessible: 'device-only', service: 'io.github.kaminarios.whip.ssh.host.a' });
});

test('false keychain write acknowledgements are failures', async () => {
  jest.mocked(Keychain.setGenericPassword).mockResolvedValueOnce(false);
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  await expect(credentialPlatform().effect(permit(), new CredentialEffect.WriteSecure({ slot: new CredentialSlot.Global(), username: 'global', value: 'PRIVATE' })))
    .rejects.toBeInstanceOf(CredentialPlatformError.SecureStorage);
  consoleError.mockRestore();
});

test('an absent secure entry is an idempotent deletion while an uncleared entry fails', async () => {
  jest.mocked(Keychain.resetGenericPassword).mockResolvedValue(false);
  const effect = new CredentialEffect.ClearSecure({ slot: new CredentialSlot.Host({ id: 'a' }) });
  await expect(credentialPlatform().effect(permit(), effect)).resolves.toMatchObject({ tag: CredentialEffectResult_Tags.Done });
  jest.mocked(Keychain.getGenericPassword).mockResolvedValueOnce({ username: 'user', password: 'PRIVATE', service: 'a' } as never);
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  await expect(credentialPlatform().effect(permit(), effect)).rejects.toBeInstanceOf(CredentialPlatformError.SecureStorage);
  consoleError.mockRestore();
});

test('vault crypto forwards opaque payloads and returns only the typed native outcome', async () => {
  vault.encryptCredential.mockResolvedValueOnce('ciphertext');
  const result = await credentialPlatform().effect(permit(), new CredentialEffect.Encrypt({ id: 'a', plaintext: 'PRIVATE' }));
  expect(vault.encryptCredential).toHaveBeenCalledWith('PRIVATE', 'a');
  expect(result).toMatchObject({ tag: CredentialEffectResult_Tags.Text, inner: { value: 'ciphertext' } });
});

test('native cancellation stops effects before their OS calls', async () => {
  const cancelled = permit();
  jest.mocked(cancelled.checkActive).mockImplementation(() => { throw new CredentialTransactionError.Cancelled(); });
  await expect(credentialPlatform().effect(cancelled, new CredentialEffect.ReadSecure({ slot: new CredentialSlot.Global() })))
    .rejects.toBeInstanceOf(CredentialPlatformError.Cancelled);
  expect(Keychain.getGenericPassword).not.toHaveBeenCalled();
});

test('authentication denial and vault cancellation remain typed', async () => {
  jest.mocked(authenticateGlobalKeychain).mockRejectedValueOnce(new Error('user refused'));
  await expect(credentialPlatform().effect(permit(), new CredentialEffect.AuthenticateGlobal())).rejects.toBeInstanceOf(CredentialPlatformError.Denied);
  vault.unlockRecoveryKey.mockRejectedValueOnce({ code: 'E_CREDENTIAL_VAULT_CANCELLED' });
  await expect(credentialPlatform().effect(permit(), new CredentialEffect.UnlockRecoveryKey())).rejects.toBeInstanceOf(CredentialPlatformError.Cancelled);
});

test('foreign exceptions cannot expose their credential-bearing messages', async () => {
  jest.mocked(Keychain.getGenericPassword).mockRejectedValueOnce(new Error('PRIVATE-PASSPHRASE'));
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  await expect(credentialPlatform().effect(permit(), new CredentialEffect.ReadSecure({ slot: new CredentialSlot.Global() })))
    .rejects.toBeInstanceOf(CredentialPlatformError.SecureStorage);
  expect(JSON.stringify(consoleError.mock.calls)).not.toContain('PRIVATE-PASSPHRASE');
  consoleError.mockRestore();
});
