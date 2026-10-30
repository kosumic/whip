import { skipToken, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import type { HerdrClient } from '../services/HerdrClient';
import { GITHUB_STALE_TIME_MS, githubDiscoveryQueryOptions } from '../services/remoteGithubQueries';
import { remoteConnectionRequest } from '../services/remoteGitQueries';

/** Discovery is local to the SSH host and never requires a GitHub login. */
export function useGithubRepository(client: HerdrClient | null, path: string | undefined, enabled: boolean) {
  const connection = client?.activeNative && remoteConnectionRequest(client);
  const active = !!(enabled && connection?.isCurrent() && path);
  const { data, refetch } = useQuery({
    ...(connection && path ? githubDiscoveryQueryOptions(connection, path) : {
      queryKey: ['remote-github', 'inactive'], queryFn: skipToken,
    }),
    enabled: active,
    refetchInterval: active ? GITHUB_STALE_TIME_MS : false,
  });
  useEffect(() => {
    if (!active) return;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void refetch();
    });
    return () => subscription.remove();
  }, [active, refetch]);
  return active ? data ?? null : null;
}
