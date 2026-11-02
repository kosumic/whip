import { skipToken, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import type { HerdrClient } from '../services/HerdrClient';
import { GITHUB_STALE_TIME_MS, githubCandidateDirectories, githubDiscoveryQueryOptions } from '../services/remoteGithubQueries';
import { remoteConnectionRequest } from '../services/remoteGitQueries';

/** Discovery is local to the SSH host and never requires a GitHub login. */
export function useGithubRepository(client: HerdrClient | null, input: readonly (string | undefined)[], enabled: boolean, scope = '') {
  const paths = githubCandidateDirectories(input);
  const connection = client?.activeNative && remoteConnectionRequest(client);
  const active = !!(enabled && connection?.isCurrent());
  const probing = active && paths.length > 0;
  const query = useQuery({
    ...(connection && paths.length ? githubDiscoveryQueryOptions(connection, paths, scope) : {
      queryKey: ['remote-github', 'inactive'], queryFn: skipToken,
    }),
    enabled: probing,
    refetchInterval: probing ? GITHUB_STALE_TIME_MS : false,
  });
  const { refetch } = query;
  useEffect(() => {
    if (!probing) return;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void refetch();
    });
    return () => subscription.remove();
  }, [probing, refetch]);
  // Never expose cached data from another candidate set or a failed refresh.
  const status = !active ? 'inactive' : !paths.length ? 'unknown-cwd'
    : query.isError ? 'probe-failure' : query.data?.status ?? 'loading';
  return {
    status,
    repository: active && status === 'found' ? query.data?.repository ?? null : null,
    attempts: query.data?.attempts ?? [],
    error: query.error,
    generation: connection?.generation,
    retrying: probing && query.isFetching,
    retry: () => { if (probing) void refetch(); },
  };
}
