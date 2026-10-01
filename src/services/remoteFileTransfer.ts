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

export async function cacheRemoteFile(client: RemoteFileClient, remotePath: string): Promise<CachedRemoteFile> {
  const directory = new Directory(
    Paths.cache,
    `herdr-remote-file-${Date.now()}-${++transferSequence}`,
  );
  directory.create({ idempotent: true });
  try {
    const nativeDirectoryPath = `${nativePath(directory.uri)}/`;
    const result = await client.native.startDownload(remotePath, nativeDirectoryPath).result;
    const downloadedPath = result.localPath;
    if (!downloadedPath) throw new Error('Native download returned no local path');
    const file = new File(fileUri(downloadedPath));
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
