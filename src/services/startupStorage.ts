import { appStorage } from './appStorage';

import { HOSTS_STORAGE_KEY, LEGACY_PROFILE_KEY } from '../lib/hostProfiles';
import {
  DEVICE_PREFERENCES_KEY,
  LEGACY_DEVICE_PREFERENCES_KEYS,
} from './devicePreferences';
import { KNOWN_HOSTS_STORAGE_KEY } from './knownHosts';
import { HERDR_SOCKET_PATH_CACHE_KEY } from './herdrSocketPathStorage';
import { LIVE_HOSTS_KEY } from './persistedLiveHosts';
import { recordStorageDiagnostic, storageErrorDetails } from './storageDiagnostics';
import { TERMINAL_HISTORY_STORAGE_KEY } from './terminalHistory';

export const STARTUP_STORAGE_KEYS = [
  HOSTS_STORAGE_KEY,
  LEGACY_PROFILE_KEY,
  DEVICE_PREFERENCES_KEY,
  ...LEGACY_DEVICE_PREFERENCES_KEYS,
  KNOWN_HOSTS_STORAGE_KEY,
  LIVE_HOSTS_KEY,
  TERMINAL_HISTORY_STORAGE_KEY,
  HERDR_SOCKET_PATH_CACHE_KEY,
] as const;

export type StartupStorageSnapshot = {
  hosts: string | null;
  legacyHost: string | null;
  preferences: string | null;
  legacyPreferences: Array<string | null>;
  knownHosts: string | null;
  liveHosts: string | null;
  terminalHistory: string | null;
  herdrSocketPaths: string | null;
};

/** Initializes/imports storage before reading startup state in one native batch. */
export async function readStartupStorage(): Promise<StartupStorageSnapshot> {
  try {
    const entries = await appStorage.multiGet([...STARTUP_STORAGE_KEYS]);
    const values = new Map(entries);
    const missingKey = STARTUP_STORAGE_KEYS.find(key => !values.has(key));
    if (missingKey) {
      throw new Error(`appStorage multiGet omitted startup key ${missingKey}`);
    }
    const value = (key: string) => values.get(key) ?? null;
    return {
      hosts: value(HOSTS_STORAGE_KEY),
      legacyHost: value(LEGACY_PROFILE_KEY),
      preferences: value(DEVICE_PREFERENCES_KEY),
      legacyPreferences: LEGACY_DEVICE_PREFERENCES_KEYS.map(value),
      knownHosts: value(KNOWN_HOSTS_STORAGE_KEY),
      liveHosts: value(LIVE_HOSTS_KEY),
      terminalHistory: value(TERMINAL_HISTORY_STORAGE_KEY),
      herdrSocketPaths: value(HERDR_SOCKET_PATH_CACHE_KEY),
    };
  } catch (error) {
    recordStorageDiagnostic('error', 'startup-storage-multiget-failed', {
      store: 'startup-storage',
      phase: 'startup',
      operation: 'multiGet',
      fallbackUsed: 'individual-reads',
      ...storageErrorDetails(error),
    });
    throw error;
  }
}
