import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import { NativeHostProfileStore } from 'react-native-whip-ssh';

import {
  HOSTS_STORAGE_KEY,
  LEGACY_CREDENTIAL_SERVICE,
  LEGACY_PROFILE_KEY,
  hostCredentialService,
  migrateLegacyProfile,
  resolveJumpHostChain,
  toHostProfile,
} from '../lib/hostProfiles';
import { settledPromise } from '../lib/promises';
import type { ConnectionProfile, HostProfile } from '../types';
import { reportBackgroundFailure } from './backgroundOperations';
import {
  backupCredential,
  ensureCredentialBackup,
  recoverCredentialForHost,
  removeCredentialBackup,
} from './credentialVault';
import {
  operationalErrorDetails,
  operationalParseErrorDetails,
  recordOperationalDiagnostic,
} from './operationalDiagnostics';
import {
  recordStorageDiagnostic,
  storageErrorDetails,
  storageParseErrorDetails,
} from './storageDiagnostics';

interface StoredCredential {
  secret?: string;
  passphrase?: string;
}

export const CREDENTIAL_BACKUP_MIGRATION_KEY = 'herdr.credentials.backup-migration';
export const CREDENTIAL_BACKUP_MIGRATION_VERSION = '1';
let credentialBackupMigration: Promise<void> | null = null;

export class HostProfilesUnavailableError extends Error {
  constructor() {
    super('Host profiles must be loaded successfully before they can be changed');
    this.name = 'HostProfilesUnavailableError';
  }
}

/** Owns canonical Rust metadata and serializes storage and credential operations. */
export class HostProfileRepository {
  private store: NativeHostProfileStore | null = null;
  private operations: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(hosts: HostProfile[]) => void>();

  subscribe(listener: (hosts: HostProfile[]) => void): () => void {
    this.listeners.add(listener);
    if (this.store) listener(this.store.view().hosts);
    return () => { this.listeners.delete(listener); };
  }

  loadHostProfiles(): Promise<HostProfile[]> {
    return this.enqueue(async () => {
      if (this.store) return this.store.view().hosts;
      let entries: readonly [string, string | null][];
      try {
        entries = await AsyncStorage.multiGet([HOSTS_STORAGE_KEY, LEGACY_PROFILE_KEY]);
        const values = new Map(entries);
        if (!values.has(HOSTS_STORAGE_KEY) || !values.has(LEGACY_PROFILE_KEY)) {
          throw new Error('AsyncStorage omitted host profile storage keys');
        }
      } catch (error) {
        recordStorageDiagnostic('error', 'storage-read-failed', {
          store: 'host-profiles',
          phase: 'startup-fallback',
          operation: 'multiGet',
          fallbackUsed: 'preserved-host-profiles',
          ...storageErrorDetails(error),
        });
        throw error;
      }
      const values = new Map(entries);
      const hosts = await this.hydrate(
        values.get(HOSTS_STORAGE_KEY) ?? null,
        values.get(LEGACY_PROFILE_KEY) ?? null,
      );
      scheduleCredentialBackupMigration(hosts);
      return hosts;
    });
  }

  loadHostProfilesFromStorage(stored: string | null, legacyValue: string | null): Promise<HostProfile[]> {
    return this.enqueue(() => this.hydrate(stored, legacyValue));
  }

  saveConnectionProfile(profile: ConnectionProfile): Promise<{ hosts: HostProfile[]; host: HostProfile }> {
    return this.enqueue(async () => {
      const next = this.draft();
      const previous = next.view().hosts.find(host => host.id === profile.id);
      const host = toHostProfile(profile, previous);
      next.upsert(host, host.updatedAt);
      const hosts = await this.persist(next, 'profile-save', async () => {
        if (profile.secret) {
          await writeCredential(profile);
        } else {
          await Keychain.resetGenericPassword({ service: hostCredentialService(profile.id) });
          await removeCredentialBackup(profile.id);
        }
      });
      return { hosts, host };
    });
  }

  /** The Hosts screen presents the connection end time as last connected. */
  markHostDisconnected(id: string): Promise<HostProfile[]> {
    return this.enqueue(async () => {
      const next = this.draft();
      next.markDisconnected(id, new Date().toISOString());
      return this.persist(next, 'disconnect-persistence');
    });
  }

  deleteHostProfile(id: string): Promise<HostProfile[]> {
    return this.enqueue(async () => {
      const next = this.draft();
      next.remove(id, new Date().toISOString());
      return this.persist(next, 'profile-delete', async () => {
        await Keychain.resetGenericPassword({ service: hostCredentialService(id) });
        await removeCredentialBackup(id);
      });
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = settledPromise(result);
    return result;
  }

  private async hydrate(stored: string | null, legacyValue: string | null): Promise<HostProfile[]> {
    // Startup snapshots may arrive again after edits; only initialize once.
    if (this.store) return this.store.view().hosts;
    const next = new NativeHostProfileStore();
    if (stored !== null) {
      try {
        next.hydrate(stored);
      } catch (error) {
        recordHostProfilesParseFailure(error, HOSTS_STORAGE_KEY);
        throw error;
      }
    } else {
      const legacy = migrateLegacyProfile(legacyValue, error => {
        recordHostProfilesParseFailure(error, LEGACY_PROFILE_KEY);
      });
      if (legacy) {
        const credential = await Keychain.getGenericPassword({ service: LEGACY_CREDENTIAL_SERVICE });
        const secrets = parseCredential(credential ? credential.password : null, legacy.id)
          || { secret: '', passphrase: '' };
        const migrated = { ...legacy, ...secrets };
        const host = toHostProfile(migrated);
        next.upsert(host, host.updatedAt);
        if (migrated.secret) await writeCredential(migrated);
        return this.persist(next, 'startup-migration');
      }
    }
    return this.publish(next);
  }

  private draft(): NativeHostProfileStore {
    if (!this.store) throw new HostProfilesUnavailableError();
    // Stage changes in Rust without exposing them before persistence succeeds.
    const next = new NativeHostProfileStore();
    next.hydrate(this.store.view().persistedValue);
    return next;
  }

  private async persist(
    next: NativeHostProfileStore,
    phase: string,
    persistCredential?: () => Promise<void>,
  ): Promise<HostProfile[]> {
    await writeHostProfiles(next.view().persistedValue, phase);
    this.store = next;
    try {
      await persistCredential?.();
    } finally {
      // Keychain cannot roll back a committed metadata write. Reflect disk even
      // when credential work fails, while retaining that failure for the caller.
      this.publish(next);
    }
    return next.view().hosts;
  }

  private publish(store: NativeHostProfileStore): HostProfile[] {
    this.store = store;
    const hosts = store.view().hosts;
    for (const listener of this.listeners) listener(hosts);
    return hosts;
  }
}

const hostProfiles = new HostProfileRepository();
export const loadHostProfiles = hostProfiles.loadHostProfiles.bind(hostProfiles);
export const loadHostProfilesFromStorage = hostProfiles.loadHostProfilesFromStorage.bind(hostProfiles);
export const saveConnectionProfile = hostProfiles.saveConnectionProfile.bind(hostProfiles);
export const markHostDisconnected = hostProfiles.markHostDisconnected.bind(hostProfiles);
export const deleteHostProfile = hostProfiles.deleteHostProfile.bind(hostProfiles);
export const subscribeToHostProfiles = hostProfiles.subscribe.bind(hostProfiles);

/** Runs the one-time backup migration without delaying host metadata rendering. */
export function scheduleCredentialBackupMigration(hosts: readonly HostProfile[]): void {
  if (credentialBackupMigration) return;
  const operation = migrateCredentialBackupsIfNeeded(hosts);
  credentialBackupMigration = operation;
  reportBackgroundFailure(operation, 'credential-backup-migration');
  const clearMigration = () => {
    if (credentialBackupMigration === operation) credentialBackupMigration = null;
  };
  operation.then(clearMigration, clearMigration);
}

export async function migrateCredentialBackupsIfNeeded(hosts: readonly HostProfile[]): Promise<void> {
  let migrationVersion: string | null;
  try {
    migrationVersion = await AsyncStorage.getItem(CREDENTIAL_BACKUP_MIGRATION_KEY);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-read-failed', {
      store: 'credential-backup-migration',
      storageKey: CREDENTIAL_BACKUP_MIGRATION_KEY,
      phase: 'startup-migration',
      operation: 'getItem',
      fallbackUsed: 'retry-next-launch',
      ...storageErrorDetails(error),
    });
    throw error;
  }
  if (migrationVersion === CREDENTIAL_BACKUP_MIGRATION_VERSION) return;
  let complete = true;
  for (const host of hosts) {
    let stage = 'keychain-read';
    try {
      const credential = await Keychain.getGenericPassword({ service: hostCredentialService(host.id) });
      if (!credential) continue;
      stage = 'credential-parse';
      const secrets = parseCredential(credential.password, host.id);
      if (!secrets) throw new Error('Stored Keychain credential is malformed or empty');
      stage = 'credential-backup';
      if (!await ensureCredentialBackup(host.id, secrets)) {
        throw new Error('Credential backup was not created');
      }
    } catch (error) {
      recordOperationalDiagnostic('warn', 'Credential', 'credential-backup-migration-item-failed', {
        hostId: host.id,
        stage,
        fallbackUsed: 'retry-next-launch',
        ...operationalErrorDetails(error),
      });
      complete = false;
    }
  }
  if (complete) {
    try {
      await AsyncStorage.setItem(CREDENTIAL_BACKUP_MIGRATION_KEY, CREDENTIAL_BACKUP_MIGRATION_VERSION);
    } catch (error) {
      recordStorageDiagnostic('error', 'storage-write-failed', {
        store: 'credential-backup-migration',
        storageKey: CREDENTIAL_BACKUP_MIGRATION_KEY,
        phase: 'startup-migration',
        operation: 'setItem',
        fallbackUsed: 'retry-next-launch',
        ...storageErrorDetails(error),
      });
      throw error;
    }
  }
}

export async function loadConnectionProfile(host: HostProfile): Promise<ConnectionProfile> {
  let credential: false | Keychain.UserCredentials = false;
  try {
    credential = await Keychain.getGenericPassword({ service: hostCredentialService(host.id) });
  } catch (error) {
    recordOperationalDiagnostic('error', 'Credential', 'keychain-credential-read-failed', {
      hostId: host.id,
      ...operationalErrorDetails(error),
    });
  }
  const primary = credential ? parseCredential(credential.password, host.id) : null;
  const secrets = primary
    || await recoverCredentialForHost(host)
    || { secret: '', passphrase: '' };
  return {
    ...host,
    ...secrets,
  };
}

export async function loadJumpHostConnectionProfiles(
  hosts: HostProfile[],
  profile: Pick<HostProfile, 'id' | 'jumpHostId'>,
): Promise<ConnectionProfile[]> {
  const jumpHosts = resolveJumpHostChain(hosts, profile);
  return Promise.all(jumpHosts.map(loadConnectionProfile));
}

async function writeCredential(profile: ConnectionProfile): Promise<void> {
  try {
    const result = await Keychain.setGenericPassword(profile.username, JSON.stringify({
      secret: profile.secret,
      passphrase: profile.passphrase,
    }), {
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      service: hostCredentialService(profile.id),
    });
    if (!result) throw new Error('Keychain did not store the host credential');
  } catch (error) {
    recordOperationalDiagnostic('error', 'Credential', 'keychain-credential-write-failed', {
      hostId: profile.id,
      ...operationalErrorDetails(error),
    });
    throw error;
  }
  await backupCredential(profile.id, {
    secret: profile.secret,
    passphrase: profile.passphrase,
  });
}

async function writeHostProfiles(value: string, phase: string): Promise<void> {
  try {
    await AsyncStorage.setItem(HOSTS_STORAGE_KEY, value);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-write-failed', {
      store: 'host-profiles',
      storageKey: HOSTS_STORAGE_KEY,
      phase,
      operation: 'setItem',
      ...storageErrorDetails(error),
    });
    throw error;
  }
}

function recordHostProfilesParseFailure(
  error: unknown,
  storageKey: string,
): void {
  recordStorageDiagnostic('error', 'storage-parse-failed', {
    store: 'host-profiles',
    storageKey,
    phase: 'startup',
    operation: 'parse',
    fallbackUsed: 'preserved-host-profiles',
    ...storageParseErrorDetails(error),
  });
}

function parseCredential(
  value: string | null,
  hostId: string,
): Required<StoredCredential> | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('Stored Keychain credential must be an object');
    }
    const credential = parsed as StoredCredential;
    if (
      typeof credential.secret !== 'string'
      || (
        credential.passphrase !== undefined
        && typeof credential.passphrase !== 'string'
      )
    ) {
      throw new TypeError('Stored Keychain credential has invalid fields');
    }
    if (!credential.secret) {
      recordOperationalDiagnostic('error', 'Credential', 'keychain-credential-empty', {
        hostId,
        fallbackUsed: 'credential-recovery',
      });
      return null;
    }
    return { secret: credential.secret, passphrase: credential.passphrase || '' };
  } catch (error) {
    recordOperationalDiagnostic('error', 'Credential', 'keychain-credential-parse-failed', {
      hostId,
      fallbackUsed: 'credential-recovery',
      ...operationalParseErrorDetails(error),
    });
    return null;
  }
}
