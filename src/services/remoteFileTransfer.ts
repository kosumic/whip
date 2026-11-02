import { Directory, File, Paths } from 'expo-file-system';
import type { HerdrClient } from './HerdrClient';
import { recordNetworkDiagnostic } from './networkDiagnostics';

export type RemoteFileClient = Pick<HerdrClient, 'native'>;
export type DownloadFailurePhase =
  'sftp' | 'staging' | 'destination-save' | 'cancelled';
export class RemoteFileTransferError extends Error {
  constructor(
    readonly phase: DownloadFailurePhase,
    readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const prefix =
      phase === 'destination-save'
        ? 'Download finished, but saving to the selected destination failed'
        : phase === 'staging'
          ? 'Could not prepare the private download file'
          : phase === 'cancelled'
            ? 'Download cancelled'
            : 'SFTP download failed';
    super(phase === 'cancelled' ? prefix : `${prefix}: ${detail}`);
    this.name = 'RemoteFileTransferError';
  }
}
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
const DOWNLOAD_DIAGNOSTIC_SOURCE = 'remote-file-download';
const STAGING_CLEANUP_DIAGNOSTIC_SOURCE =
  'remote-download-staging-cleanup-failed';
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const activeStaging = new Set<string>();
const stagedTransfers = new WeakMap<
  File | Directory,
  { transferId: string; runtimeId: string }
>();
let lastCleanupAt: number | undefined;
let transferSequence = 0;

/** Reap only expired, app-owned cache jobs; never reuse an interrupted job. */
export function cleanupExpiredDownloadStaging(): void {
  const now = Date.now();
  try {
    for (const entry of new Directory(Paths.cache).list()) {
      const match = /^(?:whip-download|herdr-remote-file)-(\d+)-\d+$/.exec(
        entry.name,
      );
      if (
        entry instanceof Directory &&
        match &&
        !activeStaging.has(entry.uri) &&
        now - Number(match[1]) > STAGING_TTL_MS
      )
        entry.delete();
    }
  } catch {
    recordNetworkDiagnostic('warn', STAGING_CLEANUP_DIAGNOSTIC_SOURCE, {
      phase: 'cleanup',
    });
  }
}
function createStaging(
  prefix: 'whip-download' | 'herdr-remote-file',
): Directory {
  const now = Date.now();
  if (
    lastCleanupAt === undefined ||
    now - lastCleanupAt >= CLEANUP_INTERVAL_MS
  ) {
    cleanupExpiredDownloadStaging();
    lastCleanupAt = now;
  }
  const directory = new Directory(
    Paths.cache,
    `${prefix}-${now}-${++transferSequence}`,
  );
  try {
    directory.create({ idempotent: false });
  } catch (error) {
    throw new RemoteFileTransferError('staging', error);
  }
  activeStaging.add(directory.uri);
  return directory;
}
function disposeStaging(directory: Directory): void {
  activeStaging.delete(directory.uri);
  try {
    if (directory.exists) directory.delete();
  } catch {
    recordNetworkDiagnostic('warn', STAGING_CLEANUP_DIAGNOSTIC_SOURCE, {
      phase: 'cleanup',
    });
  }
}
function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new RemoteFileTransferError('cancelled', undefined);
}

async function downloadToStaging(
  client: RemoteFileClient,
  remotePath: string,
  directory: Directory,
  onProgress: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<File | Directory> {
  const native = client.native;
  let transfer: ReturnType<typeof native.startDownload> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let phase: DownloadFailurePhase = 'sftp';
  const cancel = () => {
    if (transfer) {
      try {
        native.cancelTransfer(transfer.id);
      } catch {
        /* Native ownership can already be gone. */
      }
    }
  };
  try {
    checkCancelled(signal);
    transfer = native.startDownload(
      remotePath,
      `${nativePath(directory.uri)}/`,
    );
    const id = transfer.id;
    signal?.addEventListener('abort', cancel, { once: true });
    // Register before checking again: cancellation can race native admission.
    if (signal?.aborted) cancel();
    recordNetworkDiagnostic('info', DOWNLOAD_DIAGNOSTIC_SOURCE, {
      transferId: id,
      phase: 'sftp',
      outcome: 'started',
    });
    timer = setInterval(() => {
      try {
        const progress = native.transferProgress(id);
        if (progress) onProgress(progress.bytesTransferred);
      } catch {
        if (timer) clearInterval(timer);
        recordNetworkDiagnostic('warn', DOWNLOAD_DIAGNOSTIC_SOURCE, {
          transferId: id,
          phase: 'progress',
          outcome: 'unavailable',
        });
      }
    }, 250);
    const result = await transfer.result;
    checkCancelled(signal);
    phase = 'staging';
    if (!result.localPath)
      throw new Error('Native download returned no local path');
    const uri = fileUri(result.localPath);
    const info = Paths.info(uri);
    if (!info.exists)
      throw new Error('The completed private download file is missing');
    recordNetworkDiagnostic('info', DOWNLOAD_DIAGNOSTIC_SOURCE, {
      transferId: id,
      phase: 'sftp',
      outcome: 'completed',
    });
    const source = info.isDirectory ? new Directory(uri) : new File(uri);
    stagedTransfers.set(source, {
      transferId: id,
      runtimeId: native.runtimeId,
    });
    return source;
  } catch (error) {
    const failure =
      error instanceof RemoteFileTransferError
        ? error
        : new RemoteFileTransferError(
            signal?.aborted ? 'cancelled' : phase,
            error,
          );
    recordNetworkDiagnostic(
      failure.phase === 'cancelled' ? 'info' : 'error',
      DOWNLOAD_DIAGNOSTIC_SOURCE,
      { transferId: transfer?.id, phase: failure.phase, outcome: 'failed' },
    );
    throw failure;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (timer) clearInterval(timer);
    try {
      cancel();
    } catch {
      /* Cleanup must not replace the original failure. */
    }
  }
}
async function saveToDestination(
  source: File | Directory,
  destination: Directory,
  overwrite: boolean,
  signal?: AbortSignal,
): Promise<void> {
  checkCancelled(signal);
  try {
    await source.copy(destination, { overwrite });
    checkCancelled(signal);
    // Providers can acknowledge a short copy. Check known sizes without loading
    // a large file into JavaScript memory; directories retain recursive copy.
    if (
      source instanceof File &&
      !(source instanceof Directory) &&
      typeof source.size === 'number'
    ) {
      const saved = new File(destination, source.name);
      if (
        !saved.exists ||
        (typeof saved.size === 'number' && saved.size !== source.size)
      )
        throw new Error('The destination file has an unexpected byte count');
    }
    recordNetworkDiagnostic('info', DOWNLOAD_DIAGNOSTIC_SOURCE, {
      ...stagedTransfers.get(source),
      phase: 'destination-save',
      outcome: 'completed',
      provider: destination.uri.startsWith('content://')
        ? 'android-saf'
        : 'filesystem',
    });
  } catch (error) {
    if (error instanceof RemoteFileTransferError) throw error;
    recordNetworkDiagnostic('error', DOWNLOAD_DIAGNOSTIC_SOURCE, {
      ...stagedTransfers.get(source),
      phase: 'destination-save',
      outcome: 'failed',
      provider: destination.uri.startsWith('content://')
        ? 'android-saf'
        : 'filesystem',
    });
    throw new RemoteFileTransferError('destination-save', error);
  }
}

/** Pick a destination first; publish only a native-verified private download. */
export async function downloadRemoteEntry(
  client: RemoteFileClient,
  remotePath: string | (() => Promise<string>),
  onProgress: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  let destination: Directory;
  try {
    destination = await Directory.pickDirectoryAsync();
  } catch (error) {
    if (error instanceof Error && /cancel|dismiss/i.test(error.message))
      return false;
    throw error;
  }
  const directory = createStaging('whip-download');
  try {
    checkCancelled(signal);
    let sourcePath: string;
    try {
      sourcePath =
        typeof remotePath === 'string' ? remotePath : await remotePath();
    } catch (error) {
      throw new RemoteFileTransferError('sftp', error);
    }
    const source = await downloadToStaging(
      client,
      sourcePath,
      directory,
      onProgress,
      signal,
    );
    await saveToDestination(source, destination, false, signal);
    return true;
  } finally {
    disposeStaging(directory);
  }
}
export async function cacheRemoteFile(
  client: RemoteFileClient,
  remotePath: string,
  options: { utf8?: boolean } = {},
): Promise<CachedRemoteFile> {
  const directory = createStaging('herdr-remote-file');
  try {
    let file: File;
    if (options.utf8) {
      const content = await client.native.readRemoteText(remotePath);
      file = new File(
        directory,
        remotePath.slice(remotePath.lastIndexOf('/') + 1),
      );
      file.create();
      await file.write(content);
    } else {
      const downloaded = await downloadToStaging(
        client,
        remotePath,
        directory,
        () => {},
      );
      if (downloaded instanceof Directory)
        throw new RemoteFileTransferError(
          'staging',
          new Error('Expected a single remote file'),
        );
      file = downloaded;
    }
    return {
      file,
      nativePath: nativePath(file.uri),
      uri: file.uri,
      dispose: () => disposeStaging(directory),
    };
  } catch (error) {
    disposeStaging(directory);
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
  await client.native.startUpload(cached.nativePath, remoteDirectoryPath)
    .result;
}
export async function copyCachedRemoteFileToPickedDirectory(
  cached: CachedRemoteFile,
): Promise<string> {
  const destination = await Directory.pickDirectoryAsync();
  await saveToDestination(cached.file, destination, true);
  return destination.uri;
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
