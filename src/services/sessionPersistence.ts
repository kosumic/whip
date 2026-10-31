import {
  SessionPersistence,
  SessionPersistenceError,
} from 'react-native-whip-ssh';
import { appStorage } from './appStorage';
import {
  recordStorageDiagnostic,
  storageErrorDetails,
} from './storageDiagnostics';

let owner: SessionPersistence | undefined;

/** Rust owns the worker and database I/O. JS only imports legacy platform data. */
export function sessionPersistence(): SessionPersistence {
  owner ??= new SessionPersistence({
    prepare: async () => {
      try {
        await appStorage.initialize();
      } catch (error) {
        throw new SessionPersistenceError.Failed({
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    writeFailed: (hostId, message) =>
      recordStorageDiagnostic('error', 'storage-write-failed', {
        store: 'session-persistence',
        hostId,
        phase: 'persistence',
        operation: 'native-write',
        message,
      }),
  });
  return owner;
}

export async function sessionPersistenceEffect<T>(
  effect: () => Promise<T>,
): Promise<T> {
  try {
    return await effect();
  } catch (error) {
    if (SessionPersistenceError.Failed.instanceOf(error))
      throw new Error(error.inner.message);
    throw error;
  }
}

export async function terminalStorageEffect<T>(
  operation: 'read' | 'write',
  hostId: string,
  effect: () => Promise<T>,
): Promise<T> {
  try {
    return await sessionPersistenceEffect(effect);
  } catch (error) {
    recordStorageDiagnostic(
      'error',
      operation === 'read' ? 'storage-read-failed' : 'storage-write-failed',
      {
        store: 'persisted-terminal-sessions',
        storageKey: hostId,
        phase: operation === 'read' ? 'session-restore' : 'persistence',
        operation: operation === 'read' ? 'native-read' : 'native-write',
        ...storageErrorDetails(error),
      },
    );
    throw error;
  }
}
