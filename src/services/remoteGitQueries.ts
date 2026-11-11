import { infiniteQueryOptions, queryOptions, type Query } from '@tanstack/react-query';
import type { RuntimeGitDiffContext, RuntimeGitDiffExpansion, RuntimeGitHistoryCursor, RuntimeGitSummary } from 'react-native-whip-ssh';
import type { RemoteGitRepository, RemoteGitStatusEntry } from '../lib/remoteGit';
import type { HerdrClient } from './HerdrClient';
import { appQueryClient } from './appQueryClient';

export const GIT_STATE_STALE_TIME_MS = 60_000;
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
    staleTime: GIT_STATE_STALE_TIME_MS,
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
    staleTime: GIT_STATE_STALE_TIME_MS,
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
    && Date.now() - state.dataUpdatedAt < GIT_STATE_STALE_TIME_MS;
}

export function loadRemoteGitStatus(connection: RemoteGitConnection, root: string) {
  assertCurrent(connection);
  return appQueryClient.fetchQuery(gitStatusQueryOptions(connection, root));
}

export function discoverRemoteGitRepository(connection: RemoteGitConnection, path: string) {
  assertCurrent(connection);
  return appQueryClient.fetchQuery({
    queryKey: [...connectionKey(connection), path, GIT_QUERY_KIND.repository],
    staleTime: GIT_STATE_STALE_TIME_MS,
    queryFn: async () => {
      const repository = await connection.native.discoverGitRepository(path);
      assertCurrent(connection);
      return repository;
    },
  });
}

/** Read known roots without probing a tab's directory over SSH. */
export function cachedRemoteGitRepository(connection: RemoteGitConnection, path: string): RemoteGitRepository | null {
  const prefix = connectionKey(connection);
  const exact = appQueryClient.getQueryData<RemoteGitRepository | null>([...prefix, path, GIT_QUERY_KIND.repository]);
  if (exact !== undefined) return exact;
  let nearest: RemoteGitRepository | null = null;
  for (const query of appQueryClient.getQueryCache().findAll({ queryKey: prefix })) {
    if (query.queryKey.at(-1) !== GIT_QUERY_KIND.repository) continue;
    const repository = query.state.data as RemoteGitRepository | null | undefined;
    if (repository && (path === repository.root || path.startsWith(repository.root === '/' ? '/' : `${repository.root}/`))
      && (!nearest || repository.root.length > nearest.root.length)) nearest = repository;
  }
  return nearest;
}

export async function refreshCachedRemoteGitState(connection: RemoteGitConnection, root: string) {
  const status = gitStatusQueryOptions(connection, root);
  const summary = gitSummaryQueryOptions(connection, root);
  await Promise.allSettled([
    ...(appQueryClient.getQueryState(status.queryKey)?.fetchStatus === 'fetching'
      ? [appQueryClient.fetchQuery(status)] : []),
    ...(appQueryClient.getQueryState(summary.queryKey)?.fetchStatus === 'fetching'
      ? [appQueryClient.fetchInfiniteQuery(summary)] : []),
  ]);
  const hasStatus = appQueryClient.getQueryData(status.queryKey) !== undefined;
  const hasSummary = appQueryClient.getQueryData(summary.queryKey) !== undefined;
  await invalidateRemoteGitQueries(connection, root);
  await Promise.all([
    discoverRemoteGitRepository(connection, root),
    ...(hasStatus ? [appQueryClient.fetchQuery(status)] : []),
    ...(hasSummary ? [appQueryClient.fetchInfiniteQuery(summary)] : []),
  ]);
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
  const queryKey = connectionKey(connection);
  const matchesRoot = (query: Query) => {
    const path = query.queryKey[queryKey.length];
    return !root || path === root || (query.queryKey.at(-1) === GIT_QUERY_KIND.repository
      && ((typeof path === 'string' && path.startsWith(root === '/' ? root : `${root}/`))
        || (query.state.data as RemoteGitRepository | null | undefined)?.root === root));
  };
  // Prevent old metadata reads from repopulating the cache after a mutation.
  // A status refresh can overlap a viewer's initial diff read; let that finish.
  await appQueryClient.cancelQueries({
    queryKey,
    predicate: query => {
      const kind = query.queryKey.at(-1);
      return matchesRoot(query) && (kind === GIT_QUERY_KIND.status || kind === GIT_QUERY_KIND.repository || kind === GIT_QUERY_KIND.summary);
    },
  });
  await appQueryClient.invalidateQueries({ queryKey, predicate: matchesRoot, refetchType: 'none' });
  await appQueryClient.refetchQueries({
    queryKey,
    type: 'active',
    predicate: query => matchesRoot(query)
      && (query.queryKey.at(-1) === GIT_QUERY_KIND.summary || query.queryKey.at(-2) === GIT_QUERY_KIND.commitFiles),
  });
}
