import { appStorage } from './appStorage';

import {
  hydrateHerdrSocketPathCache,
  setHerdrSocketPathCacheChangeListener,
} from './herdrSocketPathCache';
import {
  recordStorageDiagnostic,
  storageErrorDetails,
} from './storageDiagnostics';

export const HERDR_SOCKET_PATH_CACHE_KEY = 'herdr.api-socket-paths.v1';

let persistenceQueue: Promise<void> = Promise.resolve();
let persistenceError: Error | null = null;

function persistedError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

setHerdrSocketPathCacheChangeListener(serialized => {
  persistenceQueue = persistenceQueue.then(async () => {
    try {
      await appStorage.setItem(HERDR_SOCKET_PATH_CACHE_KEY, serialized);
      persistenceError = null;
    } catch (error) {
      persistenceError = persistedError(error);
      recordStorageDiagnostic('warn', 'storage-write-failed', {
        store: 'herdr-socket-path-cache',
        storageKey: HERDR_SOCKET_PATH_CACHE_KEY,
        phase: 'persistence',
        operation: 'setItem',
        fallbackUsed: 'memory-cache',
        ...storageErrorDetails(error),
      });
    }
  });
});

export { hydrateHerdrSocketPathCache } from './herdrSocketPathCache';

export async function loadHerdrSocketPathCache(): Promise<void> {
  try {
    hydrateHerdrSocketPathCache(await appStorage.getItem(HERDR_SOCKET_PATH_CACHE_KEY));
  } catch (error) {
    recordStorageDiagnostic('warn', 'storage-read-failed', {
      store: 'herdr-socket-path-cache',
      storageKey: HERDR_SOCKET_PATH_CACHE_KEY,
      phase: 'hydration',
      operation: 'getItem',
      fallbackUsed: 'cold-cache',
      ...storageErrorDetails(error),
    });
    hydrateHerdrSocketPathCache(null);
  }
}

export async function flushHerdrSocketPathCacheWrites(): Promise<void> {
  await persistenceQueue;
  if (persistenceError) throw persistenceError;
}
