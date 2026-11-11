import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { RuntimeGitDiffContext, RuntimeGitDiffExpansion, RuntimeGitHistoryCursor, RuntimeGitSummary } from 'react-native-whip-ssh';
import type { RemoteGitRepository, RemoteGitStatusEntry } from '../lib/remoteGit';
import type { HerdrClient } from './HerdrClient';
import { appQueryClient } from './appQueryClient';

export const GIT_STATUS_STALE_TIME_MS = 30_000;
const GIT_QUERY_KIND = {
  status: 'status',
  summary: 'summary',
  commitFiles: 'commit-files',
  repository: 'repository',
  diff: 'diff',
} as const;
const runtimeInstances = new WeakMap<object, number>();
let nextRuntimeInstance = 0;

export interface RemoteGitConnection {
  native: HerdrClient['native'];
  generation: ReturnType<HerdrClient['native']['status']>['generation'];
  isCurrent: () => boolean;
}

export function remoteConnectionRequest(client: HerdrClient): RemoteGitConnection {
  const native = client.native;
  const generation = native.status().generation;
  return {
    native,
    generation,
    isCurrent: () => {
      if (client.activeNative !== native) return false;
      const status = native.status();
      return status.generation === generation && status.state === 'connected';
    },
  };
}

export function remoteConnectionIdentity(connection: RemoteGitConnection) {
  let instance = runtimeInstances.get(connection.native);
  if (instance === undefined) {
    instance = ++nextRuntimeInstance;
    runtimeInstances.set(connection.native, instance);
  }
  return [instance, connection.native.runtimeId, String(connection.generation)] as const;
}

function connectionKey(connection: RemoteGitConnection) {
  return ['remote-git', ...remoteConnectionIdentity(connection)] as const;
}

function assertCurrent(connection: RemoteGitConnection) {
  if (!connection.isCurrent()) throw new Error('Host connection changed during Git read');
}

export function gitStatusQueryOptions(connection: RemoteGitConnection, root: string) {
  return queryOptions({
    queryKey: [...connectionKey(connection), root, GIT_QUERY_KIND.status],
    staleTime: GIT_STATUS_STALE_TIME_MS,
    queryFn: async () => {
      assertCurrent(connection);
      const changes = await connection.native.gitStatus(root);
      assertCurrent(connection);
      return changes;
    },
  });
}

export function gitSummaryQueryOptions(connection: RemoteGitConnection, root: string) {
  return infiniteQueryOptions({
    queryKey: [...connectionKey(connection), root, GIT_QUERY_KIND.summary],
    queryFn: async ({ pageParam }): Promise<RuntimeGitSummary> => {
      assertCurrent(connection);
      const summary = await connection.native.gitSummary(root, pageParam);
      assertCurrent(connection);
      return summary;
    },
    initialPageParam: undefined as RuntimeGitHistoryCursor | undefined,
    getNextPageParam: page => page.next,
    staleTime: GIT_STATUS_STALE_TIME_MS,
  });
}

export function gitCommitFilesQueryOptions(connection: RemoteGitConnection, root: string, commit: string) {
  return queryOptions({
    queryKey: [...connectionKey(connection), root, GIT_QUERY_KIND.commitFiles, commit],
    staleTime: Infinity,
    queryFn: async () => {
      assertCurrent(connection);
      const files = await connection.native.gitCommitFiles(root, commit);
      assertCurrent(connection);
      return files;
    },
  });
}

export function hasFreshGitStatus(connection: RemoteGitConnection, root: string): boolean {
  const state = appQueryClient.getQueryState(gitStatusQueryOptions(connection, root).queryKey);
  return state?.status === 'success' && !state.isInvalidated
    && Date.now() - state.dataUpdatedAt < GIT_STATUS_STALE_TIME_MS;
}

export function loadRemoteGitStatus(connection: RemoteGitConnection, root: string) {
  assertCurrent(connection);
  return appQueryClient.fetchQuery(gitStatusQueryOptions(connection, root));
}

export function discoverRemoteGitRepository(connection: RemoteGitConnection, path: string) {
  assertCurrent(connection);
  return appQueryClient.fetchQuery({
    queryKey: [...connectionKey(connection), path, GIT_QUERY_KIND.repository],
    queryFn: async () => {
      const repository = await connection.native.discoverGitRepository(path);
      assertCurrent(connection);
      return repository;
    },
  });
}

export function loadRemoteGitDiff(
  connection: RemoteGitConnection,
  repository: RemoteGitRepository,
  status: RemoteGitStatusEntry,
  context: RuntimeGitDiffContext,
  expansions: RuntimeGitDiffExpansion[] = [],
  commit?: string,
) {
  assertCurrent(connection);
  return appQueryClient.fetchQuery({
    queryKey: [...connectionKey(connection), repository.root, GIT_QUERY_KIND.diff, repository.hasHead, status, context, expansions, commit ?? null],
    // The mounted viewer retains its diff; share native reads without retaining
    // a second set of large diff buffers after their consumers finish.
    gcTime: 0,
    queryFn: async () => {
      const diff = await connection.native.gitDiff(repository, status, context, expansions, commit);
      assertCurrent(connection);
      return diff;
    },
  });
}

export async function invalidateRemoteGitQueries(connection: RemoteGitConnection, root?: string) {
  const queryKey = root ? [...connectionKey(connection), root] : connectionKey(connection);
  // Prevent old metadata reads from repopulating the cache after a mutation.
  // A status refresh can overlap a viewer's initial diff read; let that finish.
  await appQueryClient.cancelQueries({
    queryKey,
    predicate: query => {
      const kind = query.queryKey.at(-1);
      return kind === GIT_QUERY_KIND.status || kind === GIT_QUERY_KIND.repository || kind === GIT_QUERY_KIND.summary;
    },
  });
  await appQueryClient.invalidateQueries({ queryKey, refetchType: 'none' });
  await appQueryClient.refetchQueries({
    queryKey,
    type: 'active',
    predicate: query => query.queryKey.at(-1) === GIT_QUERY_KIND.summary || query.queryKey.at(-2) === GIT_QUERY_KIND.commitFiles,
  });
}
