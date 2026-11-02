import { Directory, File, Paths } from 'expo-file-system';

import type { HerdrClient } from './HerdrClient';
import { recordNetworkDiagnostic } from './networkDiagnostics';

export type RemoteFileClient = Pick<HerdrClient, 'native'>;

export interface CachedRemoteFile {
  file: File;
  nativePath: string;
  uri: string;
  transferId?: string;
  runtimeId?: string;
  dispose: () => void;
}

export interface CachedLocalUpload {
  name: string;
  nativePath: string;
  dispose: () => void;
}

let transferSequence = 0;
const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_PREFIX = 'whip-download-';
const CACHE_PREFIX = 'herdr-remote-file-';
const activeDirectories = new Set<string>();
const DOWNLOAD_DIAGNOSTIC_SOURCE = 'remote-file-download';
interface DownloadContext {
  transferId?: string;
  runtimeId?: string;
}
function recordDownloadOutcome(
  context: DownloadContext,
  phase: 'destination-save' | 'cleanup',
  outcome: 'completed' | 'failed' | 'cancelled',
  provider?: 'android-saf' | 'filesystem',
): void {
  recordNetworkDiagnostic(
    outcome === 'failed' ? (phase === 'cleanup' ? 'warn' : 'error') : 'info',
    DOWNLOAD_DIAGNOSTIC_SOURCE,
    { ...context, phase, outcome, provider },
  );
}

export class RemoteFileDownloadError extends Error {
  constructor(
    readonly phase: 'transfer' | 'save',
    readonly transferId: string | undefined,
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`${phase === 'save' ? 'Download finished, but saving to the selected folder failed' : 'Remote download failed'}: ${reason}`, { cause });
    this.name = 'RemoteFileDownloadError';
  }
}

function createDownloadDirectory(prefix: string): Directory {
  // Recover space after process termination without reusing unverifiable files.
  // Names encode creation time; an active preview or transfer is never expired.
  try {
    for (const entry of new Directory(Paths.cache).list()) {
      if (!(entry instanceof Directory) || activeDirectories.has(entry.uri)) continue;
      const knownPrefix = [DOWNLOAD_PREFIX, CACHE_PREFIX].find(value => entry.name.startsWith(value));
      if (!knownPrefix) continue;
      const created = Number(entry.name.slice(knownPrefix.length).split('-')[0]);
      if (Number.isFinite(created) && created > 0 && Date.now() - created > STAGING_MAX_AGE_MS) {
        entry.delete();
      }
    }
  } catch {
    // Cache expiry is best effort. Creating the new directory still reports
    // permission or no-space failures for the requested download.
  }
  const directory = new Directory(Paths.cache, `${prefix}${Date.now()}-${++transferSequence}`);
  directory.create();
  activeDirectories.add(directory.uri);
  return directory;
}

function disposeDownloadDirectory(directory: Directory, context: DownloadContext = {}): void {
  activeDirectories.delete(directory.uri);
  try {
    if (directory.exists) directory.delete();
  } catch {
    // Never replace a transfer/save error with an unrelated cleanup error.
    // A later download expires abandoned staging directories.
    recordDownloadOutcome(context, 'cleanup', 'failed');
  }
}


/** Check provider metadata without buffering large downloads in JavaScript. */
async function saveDownloadedEntry(
  source: File | Directory,
  destination: Directory,
  overwrite: boolean,
  context: DownloadContext,
  signal?: AbortSignal,
): Promise<void> {
  const provider = destination.uri.startsWith('content://') ? 'android-saf' : 'filesystem';
  try {
    const expectedSize = source instanceof Directory ? undefined : source.size;
    await source.copy(destination, { overwrite });
    if (signal?.aborted) throw new Error('Download cancelled');
    if (typeof expectedSize === 'number' && Number.isFinite(expectedSize) && expectedSize >= 0) {
      // SAF document IDs are opaque. Let Expo enumerate the actual child URI
      // instead of appending a filename to the picked tree's content URI.
      const saved = provider === 'android-saf'
        ? destination.list().find((entry): entry is File => entry instanceof File && !(entry instanceof Directory) && entry.name === source.name)
        : new File(destination, source.name);
      const actualSize = saved?.size;
      if (!saved?.exists || (typeof actualSize === 'number' && Number.isFinite(actualSize) && actualSize >= 0 && actualSize !== expectedSize)) {
        throw new Error('The destination file has an unexpected byte count or is missing');
      }
    }
    recordDownloadOutcome(context, 'destination-save', 'completed', provider);
  } catch (error) {
    recordDownloadOutcome(context, 'destination-save', signal?.aborted ? 'cancelled' : 'failed', provider);
    throw new RemoteFileDownloadError('save', context.transferId, error);
  }
}

/** Download into private staging, then publish without replacing local data. */
export async function downloadRemoteEntry(
  client: RemoteFileClient,
  remotePath: string | (() => Promise<string>),
  onProgress: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  // Ask before starting a potentially large transfer. iOS picker scopes remain
  // alive until the copy completes; Android may return a SAF content URI.
  let destination: Directory;
  try {
    destination = await Directory.pickDirectoryAsync();
  } catch (error) {
    if (error instanceof Error && /cancel|dismiss/i.test(error.message)) return false;
    throw error;
  }
  const directory = createDownloadDirectory(DOWNLOAD_PREFIX);
  const native = client.native;
  const context: DownloadContext = { runtimeId: native.runtimeId };
  let transfer: ReturnType<typeof native.startDownload> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let phase: 'transfer' | 'save' = 'transfer';
  const cancel = () => {
    if (!transfer) return;
    try {
      native.cancelTransfer(transfer.id);
    } catch {
      recordDownloadOutcome(context, 'cleanup', 'failed');
    }
  };
  try {
    if (signal?.aborted) throw new Error('Download cancelled');
    const sourcePath = typeof remotePath === 'string' ? remotePath : await remotePath();
    if (signal?.aborted) throw new Error('Download cancelled');
    transfer = native.startDownload(sourcePath, `${nativePath(directory.uri)}/`);
    context.transferId = transfer.id;
    signal?.addEventListener('abort', cancel);
    // Admission can synchronously abort before the listener is attached.
    if (signal?.aborted) cancel();
    const id = transfer.id;
    timer = setInterval(() => {
      const progress = native.transferProgress(id);
      if (progress) onProgress(progress.bytesTransferred);
    }, 250);
    const result = await transfer.result;
    if (timer) { clearInterval(timer); timer = undefined; }
    if (signal?.aborted) throw new Error('Download cancelled');
    if (!result.localPath) throw new Error('Native download returned no local path');
    const info = Paths.info(fileUri(result.localPath));
    if (!info.exists) throw new Error('The downloaded staging file is missing; retry the download');
    const source = info.isDirectory ? new Directory(fileUri(result.localPath)) : new File(fileUri(result.localPath));
    // Let Expo resolve children of the picked directory. Android SAF URIs
    // cannot be joined as ordinary filesystem paths. Its copy operation checks
    // conflicts and recurses only over the safe, native-created staging tree.
    phase = 'save';
    await saveDownloadedEntry(source, destination, false, context, signal);
    if (signal?.aborted) throw new Error('Download cancelled');
    return true;
  } catch (error) {
    if (signal?.aborted) throw new Error('Download cancelled', { cause: error });
    if (error instanceof RemoteFileDownloadError) throw error;
    throw new RemoteFileDownloadError(phase, transfer?.id, error);
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (timer) clearInterval(timer);
    cancel();
    disposeDownloadDirectory(directory, context);
  }
}

export async function cacheRemoteFile(
  client: RemoteFileClient,
  remotePath: string,
  options: { utf8?: boolean } = {},
): Promise<CachedRemoteFile> {
  const directory = createDownloadDirectory(CACHE_PREFIX);
  let transferId: string | undefined;
  const context: DownloadContext = { runtimeId: client.native.runtimeId };
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
      const transfer = client.native.startDownload(remotePath, nativeDirectoryPath);
      transferId = transfer.id;
      context.transferId = transfer.id;
      const result = await transfer.result;
      const downloadedPath = result.localPath;
      if (!downloadedPath) throw new Error('Native download returned no local path');
      file = new File(fileUri(downloadedPath));
    }
    return {
      file,
      nativePath: nativePath(file.uri),
      uri: file.uri,
      transferId,
      runtimeId: context.runtimeId,
      dispose: () => {
        disposeDownloadDirectory(directory, context);
      },
    };
  } catch (error) {
    disposeDownloadDirectory(directory, context);
    throw new RemoteFileDownloadError('transfer', transferId, error);
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

export async function copyCachedRemoteFileToPickedDirectory(cached: CachedRemoteFile): Promise<string> {
  const destination = await Directory.pickDirectoryAsync();
  await saveDownloadedEntry(cached.file, destination, true, {
    transferId: cached.transferId,
    runtimeId: cached.runtimeId,
  });
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
