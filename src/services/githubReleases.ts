import { evaluateAppUpdate, type AppUpdateCheck } from 'react-native-whip-ssh';
import { queryOptions } from '@tanstack/react-query';

import { LATEST_RELEASE_API_URL, UPDATE_CHECK_TIMEOUT_MS } from '../lib/aboutLinks';
export { WHIP_REPOSITORY_URL, WHIP_RELEASES_URL, WHIP_LATEST_RELEASE_URL } from '../lib/aboutLinks';

export function appUpdateQueryOptions(installedVersion: string) {
  return queryOptions({
    queryKey: ['app-update', installedVersion],
    enabled: false,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, UPDATE_CHECK_TIMEOUT_MS);
      try {
        return await checkGithubUpdate(installedVersion, controller.signal);
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
      }
    },
  });
}

export async function checkGithubUpdate(
  installedVersion: string,
  signal: AbortSignal,
): Promise<AppUpdateCheck> {
  const response = await fetch(LATEST_RELEASE_API_URL, {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error(`GitHub release check failed (${response.status})`);
  return evaluateAppUpdate(installedVersion, await response.text());
}
