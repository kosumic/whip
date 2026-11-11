import { queryOptions } from '@tanstack/react-query';
import { appQueryClient } from './appQueryClient';
import { remoteConnectionIdentity, type RemoteGitConnection } from './remoteGitQueries';

export const REMOTE_DIRECTORY_STALE_TIME_MS = 60_000;

function assertCurrent(connection: RemoteGitConnection) {
  if (!connection.isCurrent()) throw new Error('Host connection changed during directory read');
}

export function directoryQueryOptions(connection: RemoteGitConnection, path: string) {
  return queryOptions({
    queryKey: ['remote-directory', ...remoteConnectionIdentity(connection), path],
    staleTime: REMOTE_DIRECTORY_STALE_TIME_MS,
    queryFn: async () => {
      assertCurrent(connection);
      const listing = await connection.native.listDirectory(path);
      assertCurrent(connection);
      return listing;
    },
  });
}

export function cachedRemoteDirectory(connection: RemoteGitConnection, path: string) {
  return appQueryClient.getQueryData(directoryQueryOptions(connection, path).queryKey)
    ?? connection.native.cachedDirectory(path);
}

export function loadRemoteDirectory(connection: RemoteGitConnection, path: string) {
  assertCurrent(connection);
  return appQueryClient.fetchQuery(directoryQueryOptions(connection, path));
}

export async function invalidateRemoteDirectory(connection: RemoteGitConnection, path: string) {
  const queryKey = directoryQueryOptions(connection, path).queryKey;
  await appQueryClient.cancelQueries({ queryKey });
  await appQueryClient.invalidateQueries({ queryKey, refetchType: 'none' });
}

/** Invalidate related views, refreshing only open views and the completed agent's directory. */
export async function refreshCachedRemoteDirectories(connection: RemoteGitConnection, root: string, paths: ReadonlySet<string>) {
  const prefix = ['remote-directory', ...remoteConnectionIdentity(connection)];
  const queries = appQueryClient.getQueryCache().findAll({
    queryKey: prefix,
    predicate: query => {
      const path = query.queryKey[prefix.length];
      return typeof path === 'string' && (path === root || path.startsWith(root === '/' ? root : `${root}/`));
    },
  });
  await Promise.all(queries.map(async query => {
    const path = query.queryKey[prefix.length] as string;
    const refresh = query.getObserversCount() > 0 || paths.has(path);
    // Finish an opening view's read before fetching its post-completion state.
    if (query.state.fetchStatus === 'fetching') await Promise.allSettled([loadRemoteDirectory(connection, path)]);
    await invalidateRemoteDirectory(connection, path);
    if (refresh) await loadRemoteDirectory(connection, path);
  }));
}
