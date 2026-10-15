import { Directory, File, Paths } from 'expo-file-system';

import type { HerdrClient } from './HerdrClient';

export type RemoteFileClient = Pick<HerdrClient, 'native'>;

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
  remotePath: string,
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
  const directory = new Directory(Paths.cache, `whip-download-${Date.now()}-${++transferSequence}`);
  directory.create();
  const native = client.native;
  let transfer: ReturnType<typeof native.startDownload> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const cancel = () => { if (transfer) native.cancelTransfer(transfer.id); };
  try {
    if (signal?.aborted) throw new Error('Download cancelled');
    transfer = native.startDownload(remotePath, `${nativePath(directory.uri)}/`);
    signal?.addEventListener('abort', cancel);
    const id = transfer.id;
    timer = setInterval(() => {
      const progress = native.transferProgress(id);
      if (progress) onProgress(progress.bytesTransferred);
    }, 250);
    const result = await transfer.result;
    if (signal?.aborted) throw new Error('Download cancelled');
    if (!result.localPath) throw new Error('Native download returned no local path');
    const info = Paths.info(fileUri(result.localPath));
    const source = info.isDirectory ? new Directory(fileUri(result.localPath)) : new File(fileUri(result.localPath));
    // Let Expo resolve children of the picked directory. Android SAF URIs
    // cannot be joined as ordinary filesystem paths. Its copy operation checks
    // conflicts and recurses only over the safe, native-created staging tree.
    await source.copy(destination, { overwrite: false });
    return true;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (timer) clearInterval(timer);
    if (transfer) native.cancelTransfer(transfer.id);
    if (directory.exists) directory.delete();
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
      file.write(content);
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
  client: HerdrClient,
  cached: CachedRemoteFile,
  remoteDirectoryPath: string,
  content: string,
): Promise<void> {
  cached.file.write(content);
  await client.native.startUpload(cached.nativePath, remoteDirectoryPath).result;
}

export async function copyCachedRemoteFileToPickedDirectory(cached: CachedRemoteFile): Promise<string> {
  const destination = await Directory.pickDirectoryAsync();
  await cached.file.copy(destination, { overwrite: true });
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
