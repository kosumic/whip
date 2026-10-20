import { appStorage } from './appStorage';
import * as Keychain from 'react-native-keychain';

import type { GlobalSshKey, GlobalSshKeyMaterial } from '../types';
import { createSecureId } from '../lib/secureId';
import { authenticateGlobalKeychain } from './appAuthentication';
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

export const GLOBAL_SSH_KEYS_STORAGE_KEY = 'herdr.global-ssh-keys.v1';
export const GLOBAL_SSH_KEYCHAIN_SERVICE = 'io.github.kaminarios.whip.ssh.global-keychain.v1';

interface StoredKeyMaterial {
  id: string;
  secret: string;
  passphrase: string;
}

export interface SaveGlobalSshKeyInput {
  name: string;
  fingerprint: string;
  keyType: string;
  secret: string;
  passphrase: string;
}

let keychainMutation = Promise.resolve();

export async function loadGlobalSshKeys(): Promise<GlobalSshKey[]> {
  let value: string | null;
  try {
    value = await appStorage.getItem(GLOBAL_SSH_KEYS_STORAGE_KEY);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-read-failed', {
      store: 'global-ssh-key-metadata',
      storageKey: GLOBAL_SSH_KEYS_STORAGE_KEY,
      phase: 'load',
      operation: 'getItem',
      ...storageErrorDetails(error),
    });
    throw error;
  }
  if (value === null) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      throw new TypeError('Stored global SSH key metadata is malformed');
    }
    const entries = parsed.filter(isGlobalSshKey);
    if (entries.length !== parsed.length) {
      throw new TypeError('Stored global SSH key metadata is malformed');
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-parse-failed', {
      store: 'global-ssh-key-metadata',
      storageKey: GLOBAL_SSH_KEYS_STORAGE_KEY,
      phase: 'load',
      operation: 'parse',
      ...storageParseErrorDetails(error),
    });
    throw error;
  }
}

export async function unlockGlobalSshKeychain(): Promise<GlobalSshKeyMaterial[]> {
  await authenticateGlobalKeychain();
  return loadGlobalSshKeyMaterials();
}

async function loadGlobalSshKeyMaterials(): Promise<GlobalSshKeyMaterial[]> {
  const keys = await loadGlobalSshKeys();
  let credential: false | Keychain.UserCredentials;
  try {
    credential = await Keychain.getGenericPassword({ service: GLOBAL_SSH_KEYCHAIN_SERVICE });
  } catch (error) {
    recordGlobalKeychainFailure('global-ssh-key-material-read-failed', 'keychain-read', error);
    throw error;
  }
  const materials = parseMaterials(credential ? credential.password : null);
  const materialIds = new Set(materials.map(material => material.id));
  const metadataIds = new Set(keys.map(key => key.id));
  if (
    materialIds.size !== metadataIds.size
    || [...materialIds].some(id => !metadataIds.has(id))
  ) {
    const error = new Error('Global SSH key metadata and Keychain material are inconsistent');
    recordOperationalDiagnostic('error', 'GlobalSshKeychain', 'global-ssh-key-material-inconsistent', {
      metadataCount: keys.length,
      materialCount: materials.length,
      ...operationalErrorDetails(error),
    });
    throw error;
  }
  return keys.flatMap(key => {
    const material = materials.find(candidate => candidate.id === key.id);
    return material ? [{ ...key, secret: material.secret, passphrase: material.passphrase }] : [];
  });
}

export async function saveGlobalSshKey(
  keys: GlobalSshKeyMaterial[],
  input: SaveGlobalSshKeyInput,
): Promise<GlobalSshKeyMaterial[]> {
  const now = new Date().toISOString();
  const next: GlobalSshKeyMaterial[] = [
    ...keys,
    {
      id: createGlobalSshKeyId(),
      name: input.name.trim(),
      fingerprint: input.fingerprint,
      keyType: input.keyType,
      secret: input.secret,
      passphrase: input.passphrase,
      createdAt: now,
      updatedAt: now,
    },
  ].sort((left, right) => left.name.localeCompare(right.name));
  await replaceGlobalSshKeys(keys, next);
  return next;
}

export async function deleteGlobalSshKey(
  keys: GlobalSshKeyMaterial[],
  id: string,
): Promise<GlobalSshKeyMaterial[]> {
  const next = keys.filter(key => key.id !== id);
  await replaceGlobalSshKeys(keys, next);
  return next;
}

function createGlobalSshKeyId(): string {
  return createSecureId('key');
}

async function replaceGlobalSshKeys(
  previousKeys: GlobalSshKeyMaterial[],
  keys: GlobalSshKeyMaterial[],
): Promise<void> {
  const operation = keychainMutation.then(async () => {
    try {
      await writeMaterials(keys, previousKeys.length > 0);
    } catch (error) {
      recordGlobalKeychainFailure('global-ssh-key-material-write-failed', 'keychain-write', error);
      throw error;
    }
    const metadata: GlobalSshKey[] = keys.map(({ secret: _secret, passphrase: _passphrase, ...key }) => key);
    try {
      await appStorage.setItem(GLOBAL_SSH_KEYS_STORAGE_KEY, JSON.stringify(metadata));
    } catch (error) {
      recordStorageDiagnostic('error', 'storage-write-failed', {
        store: 'global-ssh-key-metadata',
        storageKey: GLOBAL_SSH_KEYS_STORAGE_KEY,
        phase: 'persistence',
        operation: 'setItem',
        fallbackUsed: 'keychain-rollback',
        ...storageErrorDetails(error),
      });
      try {
        await writeMaterials(previousKeys, keys.length > 0);
      } catch (rollbackError) {
        recordGlobalKeychainFailure(
          'global-ssh-key-material-rollback-failed',
          'keychain-rollback',
          rollbackError,
        );
      }
      throw error;
    }
  });
  keychainMutation = operation.then(
    () => undefined,
    () => undefined,
  );
  await operation;
}

async function writeMaterials(
  keys: GlobalSshKeyMaterial[],
  requireExistingMaterialForClear = false,
): Promise<void> {
  const materials: StoredKeyMaterial[] = keys.map(key => ({
    id: key.id,
    secret: key.secret,
    passphrase: key.passphrase,
  }));
  if (materials.length > 0) {
    const result = await Keychain.setGenericPassword('global-ssh-keychain', JSON.stringify(materials), {
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      service: GLOBAL_SSH_KEYCHAIN_SERVICE,
    });
    if (!result) throw new Error('Keychain did not store global SSH key material');
  } else {
    const cleared = await Keychain.resetGenericPassword({ service: GLOBAL_SSH_KEYCHAIN_SERVICE });
    if (requireExistingMaterialForClear && !cleared) {
      throw new Error('Keychain did not clear global SSH key material');
    }
  }
}

function parseMaterials(value: string | null): StoredKeyMaterial[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      throw new TypeError('Stored global SSH key material is malformed');
    }
    const entries = parsed.filter(isStoredKeyMaterial);
    if (entries.length !== parsed.length) {
      throw new TypeError('Stored global SSH key material is malformed');
    }
    return entries;
  } catch (error) {
    recordOperationalDiagnostic('error', 'GlobalSshKeychain', 'global-ssh-key-material-parse-failed', {
      stage: 'keychain-parse',
      ...operationalParseErrorDetails(error),
    });
    throw new SyntaxError('Stored global SSH key material is malformed');
  }
}

function isStoredKeyMaterial(value: unknown): value is StoredKeyMaterial {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<StoredKeyMaterial>;
  return typeof entry.id === 'string'
    && Boolean(entry.id)
    && typeof entry.secret === 'string'
    && Boolean(entry.secret)
    && typeof entry.passphrase === 'string';
}

function recordGlobalKeychainFailure(event: string, stage: string, error: unknown): void {
  recordOperationalDiagnostic('error', 'GlobalSshKeychain', event, {
    stage,
    ...operationalErrorDetails(error),
  });
}

function isGlobalSshKey(value: unknown): value is GlobalSshKey {
  if (!value || typeof value !== 'object') return false;
  const key = value as Partial<GlobalSshKey>;
  return Boolean(
    key.id
    && typeof key.name === 'string'
    && typeof key.fingerprint === 'string'
    && typeof key.keyType === 'string'
    && typeof key.createdAt === 'string'
    && typeof key.updatedAt === 'string',
  );
}
