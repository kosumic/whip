import { queryOptions } from '@tanstack/react-query';
import { remoteConnectionIdentity, type RemoteGitConnection } from './remoteGitQueries';
import { recordDiagnostic } from './diagnosticFormatting';
import type { RuntimeGithubDiscovery } from 'react-native-whip-ssh';

export function githubCandidateDirectories(paths: readonly (string | undefined)[]): string[] {
  return [...new Set(paths.filter((path): path is string => !!path))].slice(0, 3);
}

export type GithubDiscoveryAttempt = { candidate: number; status: RuntimeGithubDiscovery['status'] };
export type GithubDiscoveryResult = RuntimeGithubDiscovery & { attempts: GithubDiscoveryAttempt[] };

// Log opaque candidate identifiers, never directory strings, CLI output or error messages.
// The query retains the original structured native error for diagnostics and retry.
const discoveryDiagnostics = new Map<string, string>();
function pathIdentifier(path: string): string {
  let hash = 0;
  for (let index = 0; index < path.length; index++) hash = (hash * 31 + path.charCodeAt(index)) % 4_294_967_296;
  return hash.toString(16);
}
function reportDiscovery(connection: RemoteGitConnection, paths: readonly string[], attempts: GithubDiscoveryAttempt[], error?: unknown) {
  const identity = remoteConnectionIdentity(connection);
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-z_-]{1,64}$/i.test(error.code)
    ? error.code : error ? 'probe-failure' : undefined;
  const summary = JSON.stringify({ attempts, failedCandidate: error ? attempts.length + 1 : undefined, code });
  const key = JSON.stringify([...identity, paths]);
  if (discoveryDiagnostics.get(key) === summary) return;
  if (discoveryDiagnostics.size >= 64) discoveryDiagnostics.clear();
  discoveryDiagnostics.set(key, summary);
  recordDiagnostic(error ? 'warn' : 'info', 'Github', 'discovery', {
    runtimeInstance: identity[0], generation: String(connection.generation),
    candidatePathIds: paths.map(pathIdentifier).join(','), outcomes: summary,
  });
}

export const GITHUB_STALE_TIME_MS = 30_000;

function connectionKey(connection: RemoteGitConnection) {
  return ['remote-github', ...remoteConnectionIdentity(connection)] as const;
}

async function currentRead<T>(connection: RemoteGitConnection, read: () => Promise<T>): Promise<T> {
  const assertCurrent = () => {
    if (!connection.isCurrent()) throw new Error('Host connection changed during GitHub read');
  };
  assertCurrent();
  const result = await read();
  assertCurrent();
  return result;
}

export function githubDiscoveryQueryOptions(connection: RemoteGitConnection, input: string | readonly string[], scope = '') {
  const paths = githubCandidateDirectories(typeof input === 'string' ? [input] : input);
  return queryOptions({
    queryKey: [...connectionKey(connection), 'repository', scope, paths],
    staleTime: GITHUB_STALE_TIME_MS,
    queryFn: async ({ signal }): Promise<GithubDiscoveryResult> => {
      const attempts: GithubDiscoveryAttempt[] = [];
      let result: RuntimeGithubDiscovery = { status: 'not-github', repository: null };
      try {
        for (const path of paths) {
          if (signal.aborted) throw new Error('GitHub discovery cancelled');
          result = await currentRead(connection, () => connection.native.discoverGithubRepository(path));
          if (signal.aborted) throw new Error('GitHub discovery cancelled');
          attempts.push({ candidate: attempts.length + 1, status: result.status });
          // A failure must never select an unrelated fallback repository. Only
          // authoritative negative results permit trying the next candidate.
          if (result.status === 'found' || result.status === 'missing-gh') break;
        }
      } catch (error) {
        if (!signal.aborted && connection.isCurrent()) reportDiscovery(connection, paths, attempts, error);
        throw error;
      }
      reportDiscovery(connection, paths, attempts);
      if (result.status !== 'found' && result.status !== 'missing-gh' && attempts.some(attempt => attempt.status === 'invalid-path')) {
        result = { status: 'invalid-path', repository: null };
      }
      return { ...result, attempts };
    },
  });
}
