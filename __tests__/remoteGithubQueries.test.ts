import { appQueryClient } from '../src/services/appQueryClient';
import { GITHUB_DETAILS_STALE_TIME_MS, githubCommentsQueryOptions, githubCountsQueryOptions, githubDetailsQueryOptions, githubDiscoveryQueryOptions, githubPageQueryOptions, postGithubComment } from '../src/services/remoteGithubQueries';
import type { RemoteGitConnection } from '../src/services/remoteGitQueries';

const repository = { directory: '/repo', nameWithOwner: 'owner/repo', url: 'https://github.com/owner/repo' };
const repositoryDetails = { description: 'Repository', stars: 42, website: 'https://example.com', license: { name: 'MIT License', url: repository.url + '/blob/main/LICENSE' } };

function setup() {
  const native = {
    runtimeId: 'github-test',
    discoverGithubRepository: jest.fn().mockResolvedValue(repository),
    githubRepositoryDetails: jest.fn().mockResolvedValue(repositoryDetails),
    githubRepositoryCounts: jest.fn().mockResolvedValue({ openIssues: 8, openPullRequests: 7 }),
    githubPage: jest.fn().mockResolvedValue({ entries: [], hasMore: false }),
    githubComments: jest.fn().mockResolvedValue({ entries: [], hasMore: false }),
    githubPostComment: jest.fn(),
  };
  const connection: RemoteGitConnection = {
    native: native as unknown as RemoteGitConnection['native'], generation: 1n,
    isCurrent: jest.fn(() => true),
  };
  return { native, connection };
}

afterEach(() => appQueryClient.clear());

test('shares count reads per repository and rejects counts from a replaced host', async () => {
  const { native, connection } = setup();
  const options = githubCountsQueryOptions(connection, repository);
  await Promise.all([appQueryClient.fetchQuery(options), appQueryClient.fetchQuery(options)]);
  expect(native.githubRepositoryCounts).toHaveBeenCalledTimes(1);
  let finish!: (counts: { openIssues: number; openPullRequests: number }) => void;
  native.githubRepositoryCounts.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const next = githubCountsQueryOptions({ ...connection, generation: 2n }, repository);
  const pending = appQueryClient.fetchQuery(next);
  jest.mocked(connection.isCurrent).mockReturnValue(false);
  finish({ openIssues: 1, openPullRequests: 0 });
  await expect(pending).rejects.toThrow('Host connection changed');
  expect(appQueryClient.getQueryData(next.queryKey)).toBeUndefined();
});

test('shares discovery reads and isolates directories and reconnect generations', async () => {
  const { native, connection } = setup();
  await Promise.all([
    appQueryClient.fetchQuery(githubDiscoveryQueryOptions(connection, '/repo')),
    appQueryClient.fetchQuery(githubDiscoveryQueryOptions(connection, '/repo')),
  ]);
  expect(native.discoverGithubRepository).toHaveBeenCalledTimes(1);
  await appQueryClient.fetchQuery(githubDiscoveryQueryOptions(connection, '/other'));
  await appQueryClient.fetchQuery(githubDiscoveryQueryOptions({ ...connection, generation: 2n }, '/repo'));
  expect(native.discoverGithubRepository).toHaveBeenCalledTimes(3);
  const replacement = setup();
  await appQueryClient.fetchQuery(githubDiscoveryQueryOptions(replacement.connection, '/repo'));
  expect(replacement.native.discoverGithubRepository).toHaveBeenCalledTimes(1);
});

test('caches stars, website and license across repeated opens and list refreshes for five minutes', async () => {
  jest.useFakeTimers();
  try {
    const { native, connection } = setup();
    const options = githubDetailsQueryOptions(connection, repository);
    await appQueryClient.fetchQuery(options);
    for (let tap = 0; tap < 5; tap++) {
      jest.advanceTimersByTime(30_000);
      await expect(appQueryClient.fetchQuery(options)).resolves.toEqual(repositoryDetails);
      await appQueryClient.fetchInfiniteQuery(githubPageQueryOptions(connection, repository, 'issues'));
    }
    expect(native.githubRepositoryDetails).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(GITHUB_DETAILS_STALE_TIME_MS);
    await appQueryClient.fetchQuery(options);
    expect(native.githubRepositoryDetails).toHaveBeenCalledTimes(2);
    expect(options.gcTime).toBeGreaterThan(options.staleTime as number);
  } finally {
    jest.useRealTimers();
  }
});

test('isolates conversations and posts once without losing an acknowledged result on reconnect', async () => {
  const { native, connection } = setup();
  await appQueryClient.fetchInfiniteQuery(githubCommentsQueryOptions(connection, repository, 7));
  await appQueryClient.fetchInfiniteQuery(githubCommentsQueryOptions(connection, repository, 8));
  expect(native.githubComments).toHaveBeenCalledTimes(2);
  const comment = { id: '9', body: 'Reply' };
  native.githubPostComment.mockImplementationOnce(() => {
    jest.mocked(connection.isCurrent).mockReturnValue(false);
    return Promise.resolve(comment);
  });
  await expect(postGithubComment(connection, repository, 7, 'Reply')).resolves.toEqual(comment);
  expect(native.githubPostComment).toHaveBeenCalledTimes(1);
  expect(() => postGithubComment(connection, repository, 7, 'Again')).toThrow('Host connection changed');
  expect(native.githubPostComment).toHaveBeenCalledTimes(1);
});

test('rejects stale discoveries and API results after a host is replaced', async () => {
  const { native, connection } = setup();
  let finish!: (value: typeof repository) => void;
  native.discoverGithubRepository.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const options = githubDiscoveryQueryOptions(connection, '/repo');
  const pending = appQueryClient.fetchQuery(options);
  jest.mocked(connection.isCurrent).mockReturnValue(false);
  finish(repository);
  await expect(pending).rejects.toThrow('Host connection changed');
  expect(appQueryClient.getQueryData(options.queryKey)).toBeUndefined();
  await expect(appQueryClient.fetchQuery(githubDetailsQueryOptions(connection, repository))).rejects.toThrow('Host connection changed');
  expect(native.githubRepositoryDetails).not.toHaveBeenCalled();
});

test('fetches each section independently and advances only when another page exists', async () => {
  const { native, connection } = setup();
  native.githubPage.mockResolvedValueOnce({ entries: [], hasMore: true });
  const options = githubPageQueryOptions(connection, repository, 'issues');
  const result = await appQueryClient.fetchInfiniteQuery(options);
  expect(native.githubPage).toHaveBeenCalledWith(repository, 'issues', 1, 'open', '');
  expect(options.getNextPageParam(result.pages[0], result.pages, 1, [1])).toBe(2);
  await appQueryClient.fetchInfiniteQuery(githubPageQueryOptions(connection, repository, 'releases'));
  expect(native.githubPage).toHaveBeenLastCalledWith(repository, 'releases', 1, 'open', '');
  expect(options.getNextPageParam({ entries: [], hasMore: false }, [], 2, [1, 2])).toBeUndefined();
});

test('keeps missing GitHub/gh results hidden and allows API failures to be retried', async () => {
  const { native, connection } = setup();
  native.discoverGithubRepository.mockResolvedValueOnce(null);
  await expect(appQueryClient.fetchQuery(githubDiscoveryQueryOptions(connection, '/plain'))).resolves.toBeNull();
  native.githubRepositoryDetails.mockRejectedValueOnce(new Error('gh auth login required'));
  const options = githubDetailsQueryOptions(connection, repository);
  await expect(appQueryClient.fetchQuery(options)).rejects.toThrow('gh auth login required');
  await expect(appQueryClient.fetchQuery(options)).resolves.toMatchObject({ stars: 42 });
  expect(native.githubRepositoryDetails).toHaveBeenCalledTimes(2);
});
