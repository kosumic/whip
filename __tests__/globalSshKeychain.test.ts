jest.mock('react-native-whip-ssh', () => require('./mockWhipSsh').createMockWhipSshModule());
import { CredentialCommand_Tags, CredentialResult } from 'react-native-whip-ssh/src/credentialTransactions';
import { credentialRequest } from '../test-support/mockCredentialTransactions';
import { deleteGlobalSshKey, loadGlobalSshKeys, saveGlobalSshKey, unlockGlobalSshKeychain } from '../src/services/globalSshKeychain';
const metadata = { id: 'key-a', name: 'Key', fingerprint: 'SHA256:public', keyType: 'ssh-ed25519', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const input = { name: metadata.name, fingerprint: metadata.fingerprint, keyType: metadata.keyType, secret: 'PRIVATE', passphrase: 'phrase' };
beforeEach(() => { credentialRequest.mockReset(); });
test('key listings come from the native metadata projection', async () => {
  credentialRequest.mockResolvedValueOnce(new CredentialResult.GlobalKeys({ keys: [metadata] }));
  await expect(loadGlobalSshKeys()).resolves.toEqual([metadata]);
  expect(credentialRequest.mock.calls[0][0].tag).toBe(CredentialCommand_Tags.LoadGlobalKeys);
});
test('unlock returns explicit private material from the native authentication workflow', async () => {
  credentialRequest.mockResolvedValueOnce(new CredentialResult.GlobalMaterials({ keys: [{ metadata, secret: input.secret, passphrase: input.passphrase }] }));
  await expect(unlockGlobalSshKeychain()).resolves.toEqual([{ ...metadata, secret: input.secret, passphrase: input.passphrase }]);
  expect(credentialRequest.mock.calls[0][0].tag).toBe(CredentialCommand_Tags.UnlockGlobalKeys);
});
test('saving never replaces canonical material with a stale caller array', async () => {
  credentialRequest.mockResolvedValueOnce(new CredentialResult.GlobalMaterials({ keys: [{ metadata, secret: input.secret, passphrase: input.passphrase }] }));
  await saveGlobalSshKey([{ ...metadata, id: 'stale', secret: 'OLD', passphrase: '' }], input);
  expect(credentialRequest.mock.calls[0][0]).toMatchObject({ tag: CredentialCommand_Tags.SaveGlobalKey, inner: { input } });
  expect(JSON.stringify(credentialRequest.mock.calls[0][0])).not.toContain('OLD');
});
test('deleting carries an ID rather than a replacement keychain snapshot', async () => {
  credentialRequest.mockResolvedValueOnce(new CredentialResult.GlobalMaterials({ keys: [] }));
  await expect(deleteGlobalSshKey([{ ...metadata, secret: 'OLD', passphrase: '' }], metadata.id)).resolves.toEqual([]);
  expect(credentialRequest.mock.calls[0][0]).toMatchObject({ tag: CredentialCommand_Tags.DeleteGlobalKey, inner: { id: metadata.id } });
});
