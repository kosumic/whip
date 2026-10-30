import type { RuntimeGithubEntry, RuntimeGithubRepository } from 'react-native-whip-ssh';
import type { RemoteGitConnection } from './remoteGitQueries';
import { downloadRemoteEntry } from './remoteFileTransfer';
import { bestEffortCleanup } from './backgroundOperations';

export async function downloadGithubAsset(connection: RemoteGitConnection, repository: RuntimeGithubRepository, asset: RuntimeGithubEntry, onProgress: (bytes: number) => void) {
  let remotePath: string | undefined;
  try {
    return await downloadRemoteEntry({ native: connection.native }, async () => {
      if (!connection.isCurrent()) throw new Error('Host connection changed before asset download');
      remotePath = await connection.native.githubPrepareAsset(repository, asset.id, asset.title);
      if (!connection.isCurrent()) throw new Error('Host connection changed during asset download');
      return remotePath;
    }, onProgress);
  } finally {
    if (remotePath && connection.isCurrent()) {
      const directory = remotePath.slice(0, remotePath.lastIndexOf('/'));
      const path = remotePath;
      bestEffortCleanup((async () => {
        await connection.native.removeRemotePath(path, false);
        await connection.native.removeRemotePath(directory, true);
      })(), 'github-asset-download-cleanup');
    }
  }
}
