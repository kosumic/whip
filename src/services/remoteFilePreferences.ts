import { appStorage } from './appStorage';

import type {
  RemoteFileSortDirection,
  RemoteFileSortField,
} from '@/src/lib/remoteFiles';
import {
  recordStorageDiagnostic,
  storageErrorDetails,
  storageParseErrorDetails,
} from './storageDiagnostics';

export const REMOTE_FILE_PREFERENCES_KEY = 'whip.remote-files.preferences.v1';

export interface RemoteFilePreferences {
  showHiddenFiles: boolean;
  sortField: RemoteFileSortField;
  sortDirection: RemoteFileSortDirection;
}

export const defaultRemoteFilePreferences: RemoteFilePreferences = {
  showHiddenFiles: false,
  sortField: 'name',
  sortDirection: 'ascending',
};

export async function loadRemoteFilePreferences(): Promise<RemoteFilePreferences> {
  let value: string | null;
  try {
    value = await appStorage.getItem(REMOTE_FILE_PREFERENCES_KEY);
  } catch (error) {
    recordStorageDiagnostic('warn', 'storage-read-failed', {
      store: 'remote-file-preferences',
      storageKey: REMOTE_FILE_PREFERENCES_KEY,
      phase: 'hydration',
      operation: 'getItem',
      fallbackUsed: 'default-preferences',
      ...storageErrorDetails(error),
    });
    return defaultRemoteFilePreferences;
  }
  if (value === null) return defaultRemoteFilePreferences;
  try {
    const parsed = JSON.parse(value) as Partial<RemoteFilePreferences>;
    const malformed = (
      typeof parsed.showHiddenFiles !== 'boolean'
      || !isSortField(parsed.sortField)
      || !isSortDirection(parsed.sortDirection)
    );
    if (malformed) {
      recordRemoteFilePreferencesParseFailure(
        new TypeError('Stored remote file preferences are malformed'),
      );
    }
    return {
      showHiddenFiles: typeof parsed.showHiddenFiles === 'boolean'
        ? parsed.showHiddenFiles
        : defaultRemoteFilePreferences.showHiddenFiles,
      sortField: isSortField(parsed.sortField)
        ? parsed.sortField
        : defaultRemoteFilePreferences.sortField,
      sortDirection: isSortDirection(parsed.sortDirection)
        ? parsed.sortDirection
        : defaultRemoteFilePreferences.sortDirection,
    };
  } catch (error) {
    recordRemoteFilePreferencesParseFailure(error);
    return defaultRemoteFilePreferences;
  }
}

export async function saveRemoteFilePreferences(
  preferences: RemoteFilePreferences,
): Promise<void> {
  try {
    await appStorage.setItem(
      REMOTE_FILE_PREFERENCES_KEY,
      JSON.stringify(preferences),
    );
  } catch (error) {
    recordStorageDiagnostic('warn', 'storage-write-failed', {
      store: 'remote-file-preferences',
      storageKey: REMOTE_FILE_PREFERENCES_KEY,
      phase: 'persistence',
      operation: 'setItem',
      ...storageErrorDetails(error),
    });
    throw error;
  }
}

function isSortField(value: unknown): value is RemoteFileSortField {
  return value === 'name' || value === 'modified' || value === 'size';
}

function isSortDirection(value: unknown): value is RemoteFileSortDirection {
  return value === 'ascending' || value === 'descending';
}

function recordRemoteFilePreferencesParseFailure(error: unknown): void {
  recordStorageDiagnostic('warn', 'storage-parse-failed', {
    store: 'remote-file-preferences',
    storageKey: REMOTE_FILE_PREFERENCES_KEY,
    phase: 'hydration',
    operation: 'parse',
    fallbackUsed: 'field-defaults',
    ...storageParseErrorDetails(error),
  });
}
