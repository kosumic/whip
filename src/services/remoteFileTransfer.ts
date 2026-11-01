import { Directory, File, Paths } from 'expo-file-system';

import type { HerdrClient } from './HerdrClient';
import { bestEffortCleanup } from './backgroundOperations';

export type RemoteFileClient = Pick<HerdrClient, 'native'> & Partial<Pick<HerdrClient, 'activeNative'>>;

export type RemoteDownloadPhase = 'selecting' | 'downloading' | 'saving' | 'completed' | 'failed' | 'cancelled';

export interface RemoteDownloadProgress {
  phase: RemoteDownloadPhase;
  bytesTransferred: number;
  totalBytes?: number;
  failedPhase?: RemoteDownloadPhase;
  error?: string;
}

const TRANSFER_POLL_INTERVAL_MS = 250;

export interface CachedRemoteFile {
  file: File;
  nativePath: string;
  uri: string;
  dispose: () => void;
}

export interface CachedLocalUpload {
  name: string;
  nativePath: string;
  dispose: () => void;
}

let transferSequence = 0;

/** Download into private staging, then publish without replacing local data. */
export async function downloadRemoteEntry(
  client: RemoteFileClient,
  remotePath: string | (() => Promise<string>),
  onProgress: (progress: RemoteDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const native = client.native;
  const generation = native.status().generation;
  let progress: RemoteDownloadProgress = { phase: 'selecting', bytesTransferred: 0 };
  const report = (update: Partial<RemoteDownloadProgress>) => {
    progress = { ...progress, ...update };
    onProgress(progress);
  };
  let directory: Directory | undefined;
  let transfer: ReturnType<typeof native.startDownload> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let connectionError: Error | undefined;
  const stopPolling = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const cancel = () => {
    stopPolling();
    signal?.removeEventListener('abort', cancel);
    if (transfer) native.cancelTransfer(transfer.id);
  };
  const checkConnection = () => {
    const status = native.status();
    if (status.generation !== generation || status.state !== 'connected'
      || ('activeNative' in client && client.activeNative !== native)) {
      throw new Error('Host connection changed during download');
    }
  };
  const check = () => {
    if (signal?.aborted) throw new Error('Download cancelled');
    if (connectionError) throw connectionError;
    checkConnection();
  };
  try {
    report({});
    check();
    // Keep the picker scope alive through the destination copy (including SAF).
    let destination: Directory;
    try {
      destination = await Directory.pickDirectoryAsync();
    } catch (error) {
      if (error instanceof Error && /cancel|dismiss/i.test(error.message)) {
        report({ phase: 'cancelled' });
        return false;
      }
      throw error;
    }
    check();
    report({ phase: 'downloading' });
    const sourcePath = typeof remotePath === 'string' ? remotePath : await remotePath();
    check();
    directory = new Directory(Paths.cache, `whip-download-${Date.now()}-${++transferSequence}`);
    directory.create();
    transfer = native.startDownload(sourcePath, `${nativePath(directory.uri)}/`);
    signal?.addEventListener('abort', cancel);
    const id = transfer.id;
    timer = setInterval(() => {
      try {
        check();
        const value = native.transferProgress(id);
        if (value) report({ bytesTransferred: value.bytesTransferred, totalBytes: value.totalBytes });
      } catch (error) {
        connectionError = error instanceof Error ? error : new Error(String(error));
        cancel();
      }
    }, TRANSFER_POLL_INTERVAL_MS);
    let result: Awaited<typeof transfer.result>;
    try {
      result = await transfer.result;
    } finally {
      stopPolling();
      signal?.removeEventListener('abort', cancel);
      transfer = undefined;
    }
    check();
    if (!result.localPath) throw new Error('Native download returned no local path');
    const info = Paths.info(fileUri(result.localPath));
    const source = info.isDirectory ? new Directory(fileUri(result.localPath)) : new File(fileUri(result.localPath));
    if (!info.isDirectory) {
      const size = (source as File).size;
      report({ phase: 'saving', bytesTransferred: size, totalBytes: size });
    } else report({ phase: 'saving' });
    // Let Expo resolve children of the picked directory. Android SAF URIs
    // cannot be joined as ordinary filesystem paths. Its copy operation checks
    // conflicts and recurses only over the safe, native-created staging tree.
    await source.copy(destination, { overwrite: false });
    // Expo's asynchronous copy cannot be interrupted. Once it starts, wait for
    // its real outcome, even if the owning UI goes away, before deleting staging.
    report({ phase: 'completed' });
    return true;
  } catch (error) {
    if (signal?.aborted && progress.phase !== 'saving') {
      report({ phase: 'cancelled' });
      return false;
    }
    const reason = connectionError && error !== connectionError
      ? new Error(`${connectionError.message}: ${String(error)}`)
      : error instanceof Error ? error : new Error(String(error));
    report({ phase: 'failed', failedPhase: progress.phase, error: String(reason) });
    throw reason;
  } finally {
    signal?.removeEventListener('abort', cancel);
    stopPolling();
    if (directory) {
      const staging = directory;
      bestEffortCleanup(Promise.resolve().then(() => {
        if (staging.exists) staging.delete();
      }), 'remote-download-cleanup');
    }
  }
}

export async function cacheRemoteFile(
  client: RemoteFileClient,
  remotePath: string,
  options: { utf8?: boolean } = {},
): Promise<CachedRemoteFile> {
  const directory = new Directory(
    Paths.cache,
    `herdr-remote-file-${Date.now()}-${++transferSequence}`,
  );
  directory.create({ idempotent: true });
  try {
    let file: File;
    if (options.utf8) {
      // Rust bounds the read and rejects malformed UTF-8 before caching it.
      const content = await client.native.readRemoteText(remotePath);
      file = new File(directory, remotePath.slice(remotePath.lastIndexOf('/') + 1));
      file.create();
      await file.write(content);
    } else {
      const nativeDirectoryPath = `${nativePath(directory.uri)}/`;
      const result = await client.native.startDownload(remotePath, nativeDirectoryPath).result;
      const downloadedPath = result.localPath;
      if (!downloadedPath) throw new Error('Native download returned no local path');
      file = new File(fileUri(downloadedPath));
    }
    return {
      file,
      nativePath: nativePath(file.uri),
      uri: file.uri,
      dispose: () => {
        if (directory.exists) directory.delete();
      },
    };
  } catch (error) {
    if (directory.exists) directory.delete();
    throw error;
  }
}

export async function saveCachedRemoteText(
  client: RemoteFileClient,
  cached: CachedRemoteFile,
  remoteDirectoryPath: string,
  content: string,
): Promise<void> {
  await cached.file.write(content);
  await client.native.startUpload(cached.nativePath, remoteDirectoryPath).result;
}

export async function pickLocalFileForUpload(): Promise<CachedLocalUpload | null> {
  const result = await File.pickFileAsync({ multipleFiles: false });
  if (result.canceled || !result.result) return null;

  const directory = new Directory(
    Paths.cache,
    `herdr-local-upload-${Date.now()}-${++transferSequence}`,
  );
  directory.create({ idempotent: true });
  try {
    const file = new File(directory, result.result.name);
    await result.result.copy(file, { overwrite: true });
    return {
      name: file.name,
      nativePath: nativePath(file.uri),
      dispose: () => {
        if (directory.exists) directory.delete();
      },
    };
  } catch (error) {
    if (directory.exists) directory.delete();
    throw error;
  }
}

function nativePath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

function fileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}
