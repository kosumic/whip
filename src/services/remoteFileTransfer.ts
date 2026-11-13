import { Directory, File, Paths } from 'expo-file-system';

import type { HerdrClient } from './HerdrClient';
import { recordNetworkDiagnostic } from './networkDiagnostics';

export type RemoteFileClient = Pick<HerdrClient, 'native'> & Partial<Pick<HerdrClient, 'activeNative'>>;

export type RemoteDownloadPhase = 'selecting' | 'queued' | 'downloading' | 'saving' | 'completed' | 'failed' | 'cancelled' | 'paused';

export interface RemoteDownloadProgress {
  phase: RemoteDownloadPhase;
  bytesTransferred: number;
  totalBytes?: number;
  failedPhase?: RemoteDownloadPhase;
  error?: string;
  bytesPerSecond?: number;
  remainingSeconds?: number;
  rateCalculating?: boolean;
  destination?: SavedRemoteDestination;
}

/** Live Expo handles; the manager persists URI descriptors and native grants. */
export interface SavedRemoteDestination {
  entry: File | Directory;
  directory: Directory;
}

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
export async function saveDownloadedEntry(
  source: File | Directory,
  destination: Directory,
  overwrite: boolean,
  context: DownloadContext,
): Promise<SavedRemoteDestination> {
  const provider = destination.uri.startsWith('content://') ? 'android-saf' : 'filesystem';
  try {
    const expectedSize = source instanceof Directory ? undefined : source.size;
    await source.copy(destination, { overwrite });
    // SAF document IDs are opaque; enumerate the actual child URI.
    const saved = provider === 'android-saf'
      ? destination.list().find(entry => entry.name === source.name && (entry instanceof Directory) === (source instanceof Directory))
      : source instanceof Directory ? new Directory(destination, source.name) : new File(destination, source.name);
    if (!saved?.exists) throw new Error('The destination file has an unexpected byte count or is missing');
    if (typeof expectedSize === 'number' && Number.isFinite(expectedSize) && expectedSize >= 0) {
      const actualSize = saved.size;
      if (typeof actualSize === 'number' && Number.isFinite(actualSize) && actualSize >= 0 && actualSize !== expectedSize) {
        throw new Error('The destination file has an unexpected byte count or is missing');
      }
    }
    recordDownloadOutcome(context, 'destination-save', 'completed', provider);
    return { entry: saved, directory: destination };
  } catch (error) {
    recordDownloadOutcome(context, 'destination-save', 'failed', provider);
    throw new RemoteFileDownloadError('save', context.transferId, error);
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
