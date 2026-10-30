import { queryOptions } from '@tanstack/react-query';
import type { RuntimeGitDiffContext, RuntimeGitDiffExpansion } from 'react-native-whip-ssh';
import type { RemoteGitRepository, RemoteGitStatusEntry } from '../lib/remoteGit';
import type { HerdrClient } from './HerdrClient';
import { appQueryClient } from './appQueryClient';

export const GIT_STATUS_STALE_TIME_MS = 30_000;
const runtimeInstances = new WeakMap<object, number>();
let nextRuntimeInstance = 0;

export interface RemoteGitConnection {
  native: HerdrClient['native'];
  generation: ReturnType<HerdrClient['native']['status']>['generation'];
  isCurrent: () => boolean;
}

function connectionKey(connection: RemoteGitConnection) {
  let instance = runtimeInstances.get(connection.native);
  if (instance === undefined) {
    instance = ++nextRuntimeInstance;
    runtimeInstances.set(connection.native, instance);
  }
  return ['remote-git', instance, connection.native.runtimeId, String(connection.generation)] as const;
}

function assertCurrent(connection: RemoteGitConnection) {
  if (!connection.isCurrent()) throw new Error('Host connection changed during Git read');
}

export function gitStatusQueryOptions(connection: RemoteGitConnection, root: string) {
  return queryOptions({
    queryKey: [...connectionKey(connection), root, 'status'],
    staleTime: GIT_STATUS_STALE_TIME_MS,
    queryFn: async () => {
      assertCurrent(connection);
      const changes = await connection.native.gitStatus(root);
      assertCurrent(connection);
      return changes;
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
    queryKey: [...connectionKey(connection), path, 'repository'],
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
) {
  assertCurrent(connection);
  return appQueryClient.fetchQuery({
    queryKey: [...connectionKey(connection), repository.root, 'diff', repository.hasHead, status, context, expansions],
    // The mounted viewer retains its diff; share native reads without retaining
    // a second set of large diff buffers after their consumers finish.
    gcTime: 0,
    queryFn: async () => {
      const diff = await connection.native.gitDiff(repository, status, context, expansions);
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
    predicate: query => query.queryKey.at(-1) === 'status' || query.queryKey.at(-1) === 'repository',
  });
  await appQueryClient.invalidateQueries({ queryKey, refetchType: 'none' });
}
