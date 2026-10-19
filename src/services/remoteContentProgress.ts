import AsyncStorage from '@react-native-async-storage/async-storage';
import type { RuntimeRemoteTextAnchor } from 'react-native-whip-ssh';

import {
  recordStorageDiagnostic,
  storageErrorDetails,
  storageParseErrorDetails,
} from './storageDiagnostics';

const REMOTE_CONTENT_PROGRESS_PREFIX = 'whip.remote-content-progress.v1:';

export interface RemoteContentIdentity {
  hostId: string;
  remotePath: string;
  fileSize: number;
  modificationDate: string;
}

export interface RemoteMediaProgress {
  kind: 'media';
  positionSeconds: number;
  durationSeconds: number;
}

export interface RemoteTextProgress {
  kind: 'text';
  offsetX: number;
  offsetY: number;
  contentWidth: number;
  contentHeight: number;
}

export interface RemotePagedTextProgress {
  kind: 'paged-text';
  anchor: RuntimeRemoteTextAnchor;
  offsetY: number;
  /** The saved page must be located again because its byte offset is stale. */
  reanchor?: boolean;
}

export type RemoteContentProgress = RemoteMediaProgress | RemoteTextProgress | RemotePagedTextProgress;

interface StoredRemoteContentProgress {
  fileSize: number;
  modificationDate: string;
  updatedAt: number;
  progress: RemoteContentProgress;
}

export async function loadRemoteContentProgress(
  identity: RemoteContentIdentity,
): Promise<RemoteContentProgress | null> {
  let value: string | null;
  try {
    value = await AsyncStorage.getItem(remoteContentProgressKey(identity));
  } catch (error) {
    recordProgressStorageFailure('storage-read-failed', 'getItem', error);
    return null;
  }
  if (value === null) return null;
  try {
    const stored = JSON.parse(value) as Partial<StoredRemoteContentProgress>;
    if (!isFiniteNonNegative(stored.fileSize)
      || typeof stored.modificationDate !== 'string'
      || !isRemoteContentProgress(stored.progress)) {
      throw new TypeError('Stored remote content progress is malformed');
    }
    const changed = stored.fileSize !== identity.fileSize
      || stored.modificationDate !== identity.modificationDate;
    if (changed) {
      switch (stored.progress.kind) {
        case 'text':
          // Keep the same offset rather than scaling it with the edited file.
          return { ...stored.progress, contentWidth: 0, contentHeight: 0 };
        case 'paged-text':
          return { ...stored.progress, reanchor: true };
        case 'media':
          return null;
      }
    }
    if (stored.progress.kind === 'paged-text'
      && stored.progress.anchor.byteOffset >= Math.max(1, identity.fileSize)) {
      return null;
    }
    return stored.progress;
  } catch (error) {
    recordStorageDiagnostic('warn', 'storage-parse-failed', {
      store: 'remote-content-progress',
      phase: 'hydration',
      operation: 'parse',
      fallbackUsed: 'no-progress',
      ...storageParseErrorDetails(error),
    });
    return null;
  }
}

export async function saveRemoteContentProgress(
  identity: RemoteContentIdentity,
  progress: RemoteContentProgress,
): Promise<void> {
  const stored: StoredRemoteContentProgress = {
    fileSize: identity.fileSize,
    modificationDate: identity.modificationDate,
    updatedAt: Date.now(),
    progress,
  };
  try {
    await AsyncStorage.setItem(remoteContentProgressKey(identity), JSON.stringify(stored));
  } catch (error) {
    recordProgressStorageFailure('storage-write-failed', 'setItem', error);
    throw error;
  }
}

export async function clearRemoteContentProgress(
  identity: RemoteContentIdentity,
): Promise<void> {
  try {
    await AsyncStorage.removeItem(remoteContentProgressKey(identity));
  } catch (error) {
    recordProgressStorageFailure('storage-remove-failed', 'removeItem', error);
    throw error;
  }
}

export function shouldSaveMediaProgress(
  positionSeconds: number,
  durationSeconds: number,
): boolean {
  if (!isFiniteNonNegative(positionSeconds) || positionSeconds < 1) return false;
  if (!isFinitePositive(durationSeconds)) return true;
  const remainingSeconds = durationSeconds - positionSeconds;
  return remainingSeconds > 15 && positionSeconds / durationSeconds < 0.95;
}

export function remoteContentProgressKey(
  identity: Pick<RemoteContentIdentity, 'hostId' | 'remotePath'>,
): string {
  return `${REMOTE_CONTENT_PROGRESS_PREFIX}${encodeURIComponent(identity.hostId)}:${encodeURIComponent(identity.remotePath)}`;
}

function isRemoteContentProgress(value: unknown): value is RemoteContentProgress {
  if (!value || typeof value !== 'object') return false;
  const progress = value as Partial<RemoteContentProgress>;
  if (progress.kind === 'paged-text') {
    const { anchor } = progress;
    if (!anchor) return false;
    return Number.isSafeInteger(anchor.pageIndex) && anchor.pageIndex >= 0
      && Number.isSafeInteger(anchor.byteOffset) && anchor.byteOffset >= 0
      && anchor.pageIndex <= anchor.byteOffset
      && Number.isSafeInteger(anchor.lineNumber) && anchor.lineNumber >= 1
      && anchor.lineNumber <= anchor.byteOffset + 1
      && (anchor.pageIndex !== 0 || (anchor.byteOffset === 0 && anchor.lineNumber === 1 && !anchor.continued))
      && typeof anchor.continued === 'boolean'
      && isFiniteNonNegative(progress.offsetY);
  }
  if (progress.kind === 'media') {
    const media = progress;
    return isFiniteNonNegative(media.positionSeconds) && isFiniteNonNegative(media.durationSeconds);
  }
  if (progress.kind === 'text') {
    const text = progress;
    return isFiniteNonNegative(text.offsetX)
      && isFiniteNonNegative(text.offsetY)
      && isFiniteNonNegative(text.contentWidth)
      && isFiniteNonNegative(text.contentHeight);
  }
  return false;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFinitePositive(value: unknown): value is number {
  return isFiniteNonNegative(value) && value > 0;
}

function recordProgressStorageFailure(
  event: 'storage-read-failed' | 'storage-write-failed' | 'storage-remove-failed',
  operation: 'getItem' | 'setItem' | 'removeItem',
  error: unknown,
): void {
  recordStorageDiagnostic('warn', event, {
    store: 'remote-content-progress',
    phase: operation === 'getItem' ? 'hydration' : 'persistence',
    operation,
    fallbackUsed: operation === 'getItem' ? 'no-progress' : undefined,
    ...storageErrorDetails(error),
  });
}
