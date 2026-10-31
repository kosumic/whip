import {
  CredentialCommand,
  CredentialRecoveryState,
  CredentialResult_Tags,
} from 'react-native-whip-ssh/src/credentialTransactions';
import type { HostProfile } from '../types';
import { credentialTransactions, material, nativeHost } from './credentialTransactions';

interface StoredCredential {
  secret: string;
  passphrase: string;
  tailcatAddress?: string;
  tailcatPrivateKey?: string;
  tailcatPublicKey?: string;
}
export interface CredentialRecoveryStatus { state: 'none' | 'ready' | 'locked' | 'unavailable'; count: number }
export interface CredentialRestoreResult { restored: number; failed: number }

async function backup(hostId: string, credential: StoredCredential, onlyMissing: boolean): Promise<boolean> {
  try {
    const result = await credentialTransactions.run(new CredentialCommand.Backup({ id: hostId, credential: material(credential), onlyMissing }));
    if (result.tag !== CredentialResult_Tags.Boolean) throw new Error('Invalid native backup result');
    return result.inner.value;
  } catch { return false; }
}
export function backupCredential(hostId: string, credential: StoredCredential): Promise<boolean> { return backup(hostId, credential, false); }
export function ensureCredentialBackup(hostId: string, credential: StoredCredential): Promise<boolean> { return backup(hostId, credential, true); }
export async function hasCredentialBackup(hostId: string): Promise<boolean> {
  const result = await credentialTransactions.run(new CredentialCommand.HasBackup({ id: hostId }));
  if (result.tag !== CredentialResult_Tags.Boolean) throw new Error('Invalid native backup result');
  return result.inner.value;
}
export async function removeCredentialBackup(hostId: string): Promise<void> {
  await credentialTransactions.run(new CredentialCommand.RemoveBackup({ id: hostId }));
}
export async function credentialRecoveryStatus(): Promise<CredentialRecoveryStatus> {
  const result = await credentialTransactions.run(new CredentialCommand.RecoveryStatus());
  if (result.tag !== CredentialResult_Tags.RecoveryStatus) throw new Error('Invalid native recovery result');
  const states = {
    [CredentialRecoveryState.None]: 'none', [CredentialRecoveryState.Ready]: 'ready',
    [CredentialRecoveryState.Locked]: 'locked', [CredentialRecoveryState.Unavailable]: 'unavailable',
  } as const;
  return { state: states[result.inner.state], count: result.inner.count };
}
export async function restoreCredentialBackups(hosts: HostProfile[]): Promise<CredentialRestoreResult> {
  const result = await credentialTransactions.run(new CredentialCommand.RestoreBackups({ hostIds: hosts.map(host => host.id) }));
  if (result.tag !== CredentialResult_Tags.Restored) throw new Error('Invalid native recovery result');
  return result.inner;
}
export async function recoverCredentialForHost(host: HostProfile): Promise<StoredCredential | null> {
  const result = await credentialTransactions.run(new CredentialCommand.RecoverHost({ host: nativeHost(host) }));
  if (result.tag !== CredentialResult_Tags.Recovered) throw new Error('Invalid native recovery result');
  return result.inner.credential ?? null;
}
