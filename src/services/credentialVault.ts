import { appStorage } from './appStorage';
import * as Keychain from 'react-native-keychain';
import { NativeModules, Platform } from 'react-native';

import { hostCredentialService } from '../lib/hostProfiles';
import type { HostProfile } from '../types';
import {
  operationalErrorDetails,
  recordOperationalDiagnostic,
} from './operationalDiagnostics';
import {
  recordStorageDiagnostic,
  storageErrorDetails,
  storageParseErrorDetails,
} from './storageDiagnostics';

const CREDENTIAL_BACKUPS_KEY = 'herdr.credential.backups.v1';

interface StoredCredential {
  secret: string;
  passphrase: string;
}

interface CredentialVaultNativeModule {
  hasLocalRecoveryKey(): Promise<boolean>;
  encryptCredential(plaintext: string, credentialId: string): Promise<string>;
  decryptCredential(ciphertext: string, credentialId: string): Promise<string>;
  unlockRecoveryKey(): Promise<boolean>;
  clearRecoveryKey(): Promise<void>;
}

export interface CredentialRecoveryStatus {
  state: 'none' | 'ready' | 'locked' | 'unavailable';
  count: number;
}

export interface CredentialRestoreResult {
  restored: number;
  failed: number;
}

let backupMutation = Promise.resolve();

function nativeModule(): CredentialVaultNativeModule | null {
  if (Platform.OS !== 'android') return null;
  return NativeModules.HerdrCredentialVault as CredentialVaultNativeModule | undefined || null;
}

export async function backupCredential(
  hostId: string,
  credential: StoredCredential,
): Promise<boolean> {
  const module = nativeModule();
  if (!module || !credential.secret) return false;
  const operation = backupMutation.then(async () => {
    const backups = await loadBackups('backup-read');
    let ciphertext: string;
    try {
      ciphertext = await module.encryptCredential(JSON.stringify(credential), hostId);
      if (!ciphertext) throw new Error('Native credential encryption returned empty ciphertext');
    } catch (error) {
      recordCredentialFailure('credential-backup-encrypt-failed', hostId, error);
      throw error;
    }
    await writeBackups({ ...backups, [hostId]: ciphertext }, 'backup-write', hostId);
  });
  backupMutation = operation.then(
    () => undefined,
    () => undefined,
  );
  try {
    await operation;
    return true;
  } catch {
    return false;
  }
}

export async function ensureCredentialBackup(
  hostId: string,
  credential: StoredCredential,
): Promise<boolean> {
  if ((await loadBackups())[hostId]) return true;
  return backupCredential(hostId, credential);
}

export async function removeCredentialBackup(hostId: string): Promise<void> {
  const remaining = await mutateBackups(backups => {
    const next = { ...backups };
    delete next[hostId];
    return next;
  });
  if (Object.keys(remaining).length === 0) {
    try {
      await nativeModule()?.clearRecoveryKey();
    } catch (error) {
      recordCredentialFailure('credential-recovery-key-clear-failed', hostId, error, 'warn');
    }
  }
}

export async function credentialRecoveryStatus(): Promise<CredentialRecoveryStatus> {
  const backups = await loadBackups();
  const count = Object.keys(backups).length;
  if (count === 0) return { state: 'none', count: 0 };
  const module = nativeModule();
  if (!module) return { state: 'unavailable', count };
  try {
    return {
      state: await module.hasLocalRecoveryKey() ? 'ready' : 'locked',
      count,
    };
  } catch (error) {
    recordOperationalDiagnostic('error', 'Credential', 'credential-recovery-status-failed', {
      operation: 'hasLocalRecoveryKey',
      ...operationalErrorDetails(error),
    });
    return { state: 'unavailable', count };
  }
}

export async function restoreCredentialBackups(
  hosts: HostProfile[],
): Promise<CredentialRestoreResult> {
  const module = nativeModule();
  if (!module) throw new Error('Credential recovery requires a new Android app build');
  const backups = await loadBackups();
  if (Object.keys(backups).length === 0) return { restored: 0, failed: 0 };
  try {
    await module.unlockRecoveryKey();
  } catch (error) {
    if ((error as { code?: unknown })?.code !== 'E_CREDENTIAL_VAULT_CANCELLED') {
      recordOperationalDiagnostic('error', 'Credential', 'credential-recovery-unlock-failed', {
        operation: 'unlockRecoveryKey',
        ...operationalErrorDetails(error),
      });
    }
    throw error;
  }

  let restored = 0;
  let failed = 0;
  for (const host of hosts) {
    const ciphertext = backups[host.id];
    if (!ciphertext) continue;
    let stage = 'decrypt';
    try {
      const credential = parseCredential(await module.decryptCredential(ciphertext, host.id));
      if (!credential.secret) throw new Error('Credential backup is empty');
      stage = 'keychain-write';
      await writeKeychainCredential(host, credential);
      restored += 1;
    } catch (error) {
      recordOperationalDiagnostic('error', 'Credential', 'credential-backup-restore-host-failed', {
        hostId: host.id,
        stage,
        ...operationalErrorDetails(error),
      });
      failed += 1;
    }
  }
  return { restored, failed };
}

export async function recoverCredentialForHost(
  host: HostProfile,
): Promise<StoredCredential | null> {
  const module = nativeModule();
  if (!module) return null;
  const ciphertext = (await loadBackups('recovery-read'))[host.id];
  if (!ciphertext) return null;
  let stage = 'recovery-key-inspection';
  try {
    if (!await module.hasLocalRecoveryKey()) return null;
    stage = 'decrypt';
    const credential = parseCredential(await module.decryptCredential(ciphertext, host.id));
    if (!credential.secret) throw new Error('Recovered credential is empty');
    stage = 'keychain-write';
    await writeKeychainCredential(host, credential);
    return credential;
  } catch (error) {
    recordOperationalDiagnostic('error', 'Credential', 'credential-recovery-failed', {
      hostId: host.id,
      stage,
      ...operationalErrorDetails(error),
    });
    return null;
  }
}

async function writeKeychainCredential(host: HostProfile, credential: StoredCredential): Promise<void> {
  const result = await Keychain.setGenericPassword(host.username, JSON.stringify(credential), {
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    service: hostCredentialService(host.id),
  });
  if (!result) throw new Error('Keychain did not store the recovered credential');
}

function parseCredential(value: string): StoredCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new SyntaxError('Stored credential backup JSON is malformed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Stored credential backup must be an object');
  }
  const credential = parsed as Partial<StoredCredential>;
  if (typeof credential.secret !== 'string' || typeof credential.passphrase !== 'string') {
    throw new TypeError('Stored credential backup has invalid fields');
  }
  return { secret: credential.secret, passphrase: credential.passphrase };
}

async function loadBackups(phase = 'load'): Promise<Record<string, string>> {
  let value: string | null;
  try {
    value = await appStorage.getItem(CREDENTIAL_BACKUPS_KEY);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-read-failed', {
      store: 'credential-backups',
      storageKey: CREDENTIAL_BACKUPS_KEY,
      phase,
      operation: 'getItem',
      fallbackUsed: 'mutation-blocked',
      ...storageErrorDetails(error),
    });
    throw error;
  }
  if (value === null) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('Stored credential backups must be an object');
    }
    const entries = Object.entries(parsed);
    if (entries.some(([hostId, ciphertext]) => !hostId || typeof ciphertext !== 'string' || !ciphertext)) {
      throw new TypeError('Stored credential backups contain an invalid entry');
    }
    return Object.fromEntries(entries);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-parse-failed', {
      store: 'credential-backups',
      storageKey: CREDENTIAL_BACKUPS_KEY,
      phase,
      operation: 'parse',
      fallbackUsed: 'mutation-blocked',
      ...storageParseErrorDetails(error),
    });
    throw error;
  }
}

async function writeBackups(
  backups: Record<string, string>,
  phase: string,
  hostId?: string,
): Promise<void> {
  try {
    await appStorage.setItem(CREDENTIAL_BACKUPS_KEY, JSON.stringify(backups));
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-write-failed', {
      store: 'credential-backups',
      storageKey: CREDENTIAL_BACKUPS_KEY,
      phase,
      operation: 'setItem',
      hostId,
      ...storageErrorDetails(error),
    });
    throw error;
  }
}

async function mutateBackups(
  mutation: (backups: Record<string, string>) => Record<string, string>,
): Promise<Record<string, string>> {
  let result: Record<string, string> = {};
  const operation = backupMutation.then(async () => {
    result = mutation(await loadBackups('mutation-read'));
    await writeBackups(result, 'mutation-write');
  });
  backupMutation = operation.then(
    () => undefined,
    () => undefined,
  );
  await operation;
  return result;
}

function recordCredentialFailure(
  event: string,
  hostId: string,
  error: unknown,
  level: 'warn' | 'error' = 'error',
): void {
  recordOperationalDiagnostic(level, 'Credential', event, {
    hostId,
    ...operationalErrorDetails(error),
  });
}
