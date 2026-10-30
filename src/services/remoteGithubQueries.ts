import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { RuntimeGithubPage, RuntimeGithubRepository, RuntimeGithubSection, RuntimeGithubListState, RuntimeGithubResource, RuntimeGithubFilesPage, RuntimeGithubMutation } from 'react-native-whip-ssh';
import { remoteConnectionIdentity, type RemoteGitConnection } from './remoteGitQueries';

export const GITHUB_STALE_TIME_MS = 30_000;
export const GITHUB_DETAILS_STALE_TIME_MS = 5 * 60_000;
const GITHUB_PAGING = { initialPageParam: 1, maxPages: 1,
  getPreviousPageParam: (_firstPage: unknown, _pages: unknown[], page: number) => page > 1 ? page - 1 : undefined,
} as const;

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

export function githubDiscoveryQueryOptions(connection: RemoteGitConnection, path: string) {
  return queryOptions({
    queryKey: [...connectionKey(connection), 'repository', path],
    staleTime: GITHUB_STALE_TIME_MS,
    queryFn: () => currentRead(connection, () => connection.native.discoverGithubRepository(path)),
  });
}

export function githubDetailsQueryOptions(connection: RemoteGitConnection, repository: RuntimeGithubRepository) {
  return queryOptions({
    queryKey: [...connectionKey(connection), repository.nameWithOwner, 'details'],
    staleTime: GITHUB_DETAILS_STALE_TIME_MS,
    gcTime: GITHUB_DETAILS_STALE_TIME_MS * 2,
    queryFn: () => currentRead(connection, () => connection.native.githubRepositoryDetails(repository)),
  });
}

export function githubCommentsQueryOptions(connection: RemoteGitConnection, repository: RuntimeGithubRepository, number: number) {
  return infiniteQueryOptions({
    queryKey: [...connectionKey(connection), repository.nameWithOwner, 'comments', number],
    staleTime: GITHUB_STALE_TIME_MS,
    ...GITHUB_PAGING,
    getNextPageParam: (lastPage: RuntimeGithubPage, _pages, page) => lastPage.hasMore ? page + 1 : undefined,
    queryFn: ({ pageParam }) => currentRead(connection, () => connection.native.githubComments(repository, number, pageParam)),
  });
}

export function postGithubComment(connection: RemoteGitConnection, repository: RuntimeGithubRepository, number: number, body: string) {
  if (!connection.isCurrent()) throw new Error('Host connection changed before posting GitHub comment');
  // The backend owns validation and sends exactly one request. Keep acknowledgements
  // even if the connection changes after GitHub accepts the comment.
  return connection.native.githubPostComment(repository, number, body);
}

export function githubPageQueryOptions(connection: RemoteGitConnection, repository: RuntimeGithubRepository, section: RuntimeGithubSection, state: RuntimeGithubListState = 'open', query = '') {
  return infiniteQueryOptions({
    queryKey: [...connectionKey(connection), repository.nameWithOwner, section, state, query],
    staleTime: GITHUB_STALE_TIME_MS,
    ...GITHUB_PAGING,
    getNextPageParam: (lastPage: RuntimeGithubPage, _pages, lastPageNumber) => lastPage.hasMore ? lastPageNumber + 1 : undefined,
    queryFn: ({ pageParam }) => currentRead(connection, () => connection.native.githubPage(repository, section, pageParam, state, query)),
  });
}

export function githubEntryQueryOptions(connection: RemoteGitConnection, repository: RuntimeGithubRepository, section: RuntimeGithubSection, id: string) {
  return queryOptions({
    queryKey: [...connectionKey(connection), repository.nameWithOwner, 'entry', section, id],
    staleTime: GITHUB_STALE_TIME_MS,
    queryFn: () => currentRead(connection, () => connection.native.githubEntry(repository, section, id)),
  });
}

export function githubResourceQueryOptions(connection: RemoteGitConnection, repository: RuntimeGithubRepository, resource: RuntimeGithubResource, id: string) {
  return infiniteQueryOptions({
    queryKey: [...connectionKey(connection), repository.nameWithOwner, 'resource', resource, id],
    staleTime: GITHUB_STALE_TIME_MS,
    ...GITHUB_PAGING,
    getNextPageParam: (lastPage: RuntimeGithubPage, _pages, page) => lastPage.hasMore ? page + 1 : undefined,
    queryFn: ({ pageParam }) => currentRead(connection, () => connection.native.githubResource(repository, resource, id, pageParam)),
  });
}

export function githubFilesQueryOptions(connection: RemoteGitConnection, repository: RuntimeGithubRepository, id: string, pull: boolean) {
  return infiniteQueryOptions({
    queryKey: [...connectionKey(connection), repository.nameWithOwner, 'files', pull, id],
    staleTime: GITHUB_STALE_TIME_MS,
    ...GITHUB_PAGING,
    getNextPageParam: (lastPage: RuntimeGithubFilesPage, _pages, page) => lastPage.hasMore ? page + 1 : undefined,
    queryFn: ({ pageParam }) => currentRead(connection, () => connection.native.githubFiles(repository, id, pull, pageParam)),
  });
}

export function mutateGithub(connection: RemoteGitConnection, repository: RuntimeGithubRepository, action: RuntimeGithubMutation, id = '', title = '', body = '', expectedHead = '') {
  if (!connection.isCurrent()) throw new Error('Host connection changed before GitHub action');
  return connection.native.githubMutate(repository, action, id, title, body, expectedHead);
}

// Refresh content after writes without invalidating the longer-lived star cache.
export function githubContentFilter(connection: RemoteGitConnection, repository: RuntimeGithubRepository) {
  const prefix = [...connectionKey(connection), repository.nameWithOwner];
  return { predicate: ({ queryKey }: { queryKey: readonly unknown[] }) => prefix.every((value, i) => queryKey[i] === value) && queryKey[prefix.length] !== 'details' };
}
