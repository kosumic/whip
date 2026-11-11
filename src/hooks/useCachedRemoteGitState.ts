import { useCallback, useSyncExternalStore } from 'react';
import { skipToken, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { HerdrClient } from '../services/HerdrClient';
import { appQueryClient } from '../services/appQueryClient';
import { cachedRemoteGitRepository, gitStatusQueryOptions, gitSummaryQueryOptions, remoteConnectionRequest } from '../services/remoteGitQueries';

/** Observe available Git metadata without starting requests for Herd rows. */
export function useCachedRemoteGitState(client: HerdrClient | undefined, path: string | undefined) {
  const subscribe = useCallback((listener: () => void) => appQueryClient.getQueryCache().subscribe(event => {
    const key = event.query.queryKey as readonly unknown[];
    if (key[0] === 'remote-git') listener();
  }), []);
  const snapshot = useCallback(() => {
    if (!client?.activeNative || !path) return null;
    return cachedRemoteGitRepository(remoteConnectionRequest(client), path);
  }, [client, path]);
  const repository = useSyncExternalStore(subscribe, snapshot, snapshot);
  const root = repository?.root;
  const connection = client?.activeNative ? remoteConnectionRequest(client) : null;
  const status = useQuery({
    ...(connection && root ? gitStatusQueryOptions(connection, root)
      : { queryKey: ['remote-git', 'unavailable-status'], queryFn: skipToken }),
    enabled: false,
  }, appQueryClient);
  const summary = useInfiniteQuery({
    ...(connection && root ? gitSummaryQueryOptions(connection, root)
      : { queryKey: ['remote-git', 'unavailable-summary'], queryFn: skipToken, initialPageParam: undefined, getNextPageParam: () => undefined }),
    enabled: false,
  }, appQueryClient);
  const firstPage = summary.data?.pages[0];
  return {
    branch: firstPage?.branch ?? firstPage?.commits[0]?.shortId,
    changedFiles: status.data?.length,
  };
}
