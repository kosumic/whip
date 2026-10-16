import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  recordStorageDiagnostic,
  storageErrorDetails,
  storageParseErrorDetails,
} from './storageDiagnostics';
import { isUnknownArray } from '../lib/unknown';
import { settledPromise } from '../lib/promises';

export const REMOTE_GIT_PREFERENCES_KEY = 'whip.remote-git-mode.v1';
export const REMOTE_GIT_TREE_PREFERENCES_KEY = 'whip.remote-git-tree.v1';
const MAX_REPOSITORIES = 100;
const MAX_COLLAPSED_PATHS = 500;
// Each key holds every repository, so serialize the entire read-modify-write.
const mutations = new Map<string, Promise<void>>();

function enqueueMutation(storageKey: string, mutate: () => Promise<void>): Promise<void> {
  const operation = (mutations.get(storageKey) ?? Promise.resolve()).then(mutate);
  mutations.set(storageKey, settledPromise(operation));
  return operation;
}

interface StoredRepositoryMode {
  hostId: string;
  root: string;
  updatedAt: number;
}

interface StoredRepositoryTree {
  hostId: string;
  root: string;
  collapsedPaths: string[];
  updatedAt: number;
}

export async function loadRemoteGitMode(
  hostId: string,
  root: string,
): Promise<boolean> {
  await (mutations.get(REMOTE_GIT_PREFERENCES_KEY) ?? Promise.resolve());
  const entries = await loadEntries();
  return entries.some(entry => entry.hostId === hostId && entry.root === root);
}

export async function saveRemoteGitMode(
  hostId: string,
  root: string,
  enabled: boolean,
): Promise<void> {
  await enqueueMutation(REMOTE_GIT_PREFERENCES_KEY, async () => {
    const entries = (await loadEntries()).filter(
      entry => entry.hostId !== hostId || entry.root !== root,
    );
    if (enabled) entries.unshift({ hostId, root, updatedAt: Date.now() });
    await writeEntries(
      REMOTE_GIT_PREFERENCES_KEY,
      entries.slice(0, MAX_REPOSITORIES),
      'remote-git-mode',
    );
  });
}

export async function loadRemoteGitCollapsedPaths(
  hostId: string,
  root: string,
): Promise<string[]> {
  await (mutations.get(REMOTE_GIT_TREE_PREFERENCES_KEY) ?? Promise.resolve());
  const entries = await loadTreeEntries();
  return (
    entries.find(entry => entry.hostId === hostId && entry.root === root)
      ?.collapsedPaths || []
  );
}

export async function saveRemoteGitCollapsedPaths(
  hostId: string,
  root: string,
  collapsedPaths: readonly string[],
): Promise<void> {
  const paths = [...new Set(collapsedPaths)].slice(0, MAX_COLLAPSED_PATHS);
  await enqueueMutation(REMOTE_GIT_TREE_PREFERENCES_KEY, async () => {
    const entries = (await loadTreeEntries()).filter(
      entry => entry.hostId !== hostId || entry.root !== root,
    );
    entries.unshift({ hostId, root, collapsedPaths: paths, updatedAt: Date.now() });
    await writeEntries(
      REMOTE_GIT_TREE_PREFERENCES_KEY,
      entries.slice(0, MAX_REPOSITORIES),
      'remote-git-tree',
    );
  });
}

async function loadEntries(): Promise<StoredRepositoryMode[]> {
  const parsed = await readEntries(REMOTE_GIT_PREFERENCES_KEY, 'remote-git-mode');
  try {
    if (!parsed.every(isStoredRepositoryMode)) {
      throw new TypeError('Stored remote Git mode preferences contain an invalid entry');
    }
    return parsed.sort((first, second) => second.updatedAt - first.updatedAt);
  } catch (error) {
    recordParseFailure(REMOTE_GIT_PREFERENCES_KEY, 'remote-git-mode', error);
    throw error;
  }
}

async function loadTreeEntries(): Promise<StoredRepositoryTree[]> {
  const parsed = await readEntries(REMOTE_GIT_TREE_PREFERENCES_KEY, 'remote-git-tree');
  try {
    if (!parsed.every(isStoredRepositoryTree)) {
      throw new TypeError('Stored remote Git tree preferences contain an invalid entry');
    }
    return parsed.sort((first, second) => second.updatedAt - first.updatedAt);
  } catch (error) {
    recordParseFailure(REMOTE_GIT_TREE_PREFERENCES_KEY, 'remote-git-tree', error);
    throw error;
  }
}

async function readEntries(storageKey: string, store: string): Promise<unknown[]> {
  let value: string | null;
  try {
    value = await AsyncStorage.getItem(storageKey);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-read-failed', {
      store,
      storageKey,
      phase: 'load-before-mutation',
      operation: 'getItem',
      fallbackUsed: 'mutation-blocked',
      ...storageErrorDetails(error),
    });
    throw error;
  }
  if (value === null) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isUnknownArray(parsed)) {
      throw new TypeError('Stored remote Git preferences must be an array');
    }
    return parsed;
  } catch (error) {
    recordParseFailure(storageKey, store, error);
    throw error;
  }
}

async function writeEntries(
  storageKey: string,
  entries: readonly (StoredRepositoryMode | StoredRepositoryTree)[],
  store: string,
): Promise<void> {
  try {
    await AsyncStorage.setItem(storageKey, JSON.stringify(entries));
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-write-failed', {
      store,
      storageKey,
      phase: 'persistence',
      operation: 'setItem',
      ...storageErrorDetails(error),
    });
    throw error;
  }
}

function recordParseFailure(storageKey: string, store: string, error: unknown): void {
  recordStorageDiagnostic('error', 'storage-parse-failed', {
    store,
    storageKey,
    phase: 'load-before-mutation',
    operation: 'parse',
    fallbackUsed: 'mutation-blocked',
    ...storageParseErrorDetails(error),
  });
}

function isStoredRepositoryMode(entry: unknown): entry is StoredRepositoryMode {
  return Boolean(
    entry
    && typeof entry === 'object'
    && typeof (entry as StoredRepositoryMode).hostId === 'string'
    && typeof (entry as StoredRepositoryMode).root === 'string'
    && typeof (entry as StoredRepositoryMode).updatedAt === 'number',
  );
}

function isStoredRepositoryTree(entry: unknown): entry is StoredRepositoryTree {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as StoredRepositoryTree;
  return typeof candidate.hostId === 'string'
    && typeof candidate.root === 'string'
    && Array.isArray(candidate.collapsedPaths)
    && candidate.collapsedPaths.every(path => typeof path === 'string')
    && typeof candidate.updatedAt === 'number';
}
