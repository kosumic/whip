import { evaluateAppUpdate, type AppUpdateCheck } from 'react-native-whip-ssh';

const WHIP_GITHUB_REPOSITORY = 'kosumic/whip';
export const WHIP_REPOSITORY_URL = `https://github.com/${WHIP_GITHUB_REPOSITORY}`;
export const WHIP_RELEASES_URL = `${WHIP_REPOSITORY_URL}/releases`;
export const WHIP_LATEST_RELEASE_URL = `${WHIP_RELEASES_URL}/latest`;
const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${WHIP_GITHUB_REPOSITORY}/releases/latest`;

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
