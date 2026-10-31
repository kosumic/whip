import { CredentialCommand, CredentialResult_Tags, type CredentialResult } from 'react-native-whip-ssh/src/credentialTransactions';
import type { GlobalSshKey, GlobalSshKeyMaterial } from '../types';
import { credentialTransactions, GLOBAL_SSH_KEYCHAIN_SERVICE } from './credentialTransactions';

export { GLOBAL_SSH_KEYCHAIN_SERVICE };
export const GLOBAL_SSH_KEYS_STORAGE_KEY = 'herdr.global-ssh-keys.v1';
export interface SaveGlobalSshKeyInput {
  name: string;
  fingerprint: string;
  keyType: string;
  secret: string;
  passphrase: string;
}

function privateKeys(result: CredentialResult): GlobalSshKeyMaterial[] {
  if (result.tag !== CredentialResult_Tags.GlobalMaterials) throw new Error('Invalid native global key result');
  return result.inner.keys.map(({ metadata, secret, passphrase }) => ({ ...metadata, secret, passphrase }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
export async function loadGlobalSshKeys(): Promise<GlobalSshKey[]> {
  const result = await credentialTransactions.run(new CredentialCommand.LoadGlobalKeys());
  if (result.tag !== CredentialResult_Tags.GlobalKeys) throw new Error('Invalid native global key result');
  return [...result.inner.keys].sort((left, right) => left.name.localeCompare(right.name));
}
export async function unlockGlobalSshKeychain(): Promise<GlobalSshKeyMaterial[]> {
  const result = await credentialTransactions.run(new CredentialCommand.UnlockGlobalKeys());
  return privateKeys(result);
}
export async function saveGlobalSshKey(_keys: GlobalSshKeyMaterial[], input: SaveGlobalSshKeyInput): Promise<GlobalSshKeyMaterial[]> {
  const result = await credentialTransactions.run(new CredentialCommand.SaveGlobalKey({ input }));
  return privateKeys(result);
}
export async function deleteGlobalSshKey(_keys: GlobalSshKeyMaterial[], id: string): Promise<GlobalSshKeyMaterial[]> {
  const result = await credentialTransactions.run(new CredentialCommand.DeleteGlobalKey({ id }));
  return privateKeys(result);
}
