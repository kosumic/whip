import {
  discoverRemoteGitRepository,
  GIT_STATE_STALE_TIME_MS,
  gitStatusQueryOptions,
  gitSummaryQueryOptions,
  gitCommitFilesQueryOptions,
  hasFreshGitStatus,
  invalidateRemoteGitQueries,
  loadRemoteGitDiff,
  loadRemoteGitStatus,
  type RemoteGitConnection,
} from '../src/services/remoteGitQueries';
import { appQueryClient } from '../src/services/appQueryClient';
import { isCancelledError } from '@tanstack/react-query';
import type { RemoteGitDiff, RemoteGitStatusEntry } from '../src/lib/remoteGit';

const repository = { root: '/repo', hasHead: true };
const status: RemoteGitStatusEntry = {
  path: 'file.ts', absolutePath: '/repo/file.ts', originalPath: null, indexStatus: ' ', worktreeStatus: 'M',
};
const diff: RemoteGitDiff = { kind: 'empty', rows: [], hunkRows: [], additions: 0, deletions: 0, truncated: false };

function setup() {
  const native = {
    runtimeId: 'runtime-1',
    gitStatus: jest.fn().mockResolvedValue([status]),
    discoverGitRepository: jest.fn().mockResolvedValue(repository),
    gitDiff: jest.fn().mockResolvedValue(diff),
    gitSummary: jest.fn().mockResolvedValue({ branch: 'main', commits: [] }),
    gitCommitFiles: jest.fn().mockResolvedValue([status]),
  };
  const connection: RemoteGitConnection = {
    native: native as unknown as RemoteGitConnection['native'],
    generation: 1n,
    isCurrent: jest.fn(() => true),
  };
  return { connection, native };
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

test('shares simultaneous status requests and reuses fresh data until invalidated or expired', async () => {
  const { connection, native } = setup();
  await Promise.all([loadRemoteGitStatus(connection, repository.root), loadRemoteGitStatus(connection, repository.root)]);
  expect(native.gitStatus).toHaveBeenCalledTimes(1);
  expect(hasFreshGitStatus(connection, repository.root)).toBe(true);
  await loadRemoteGitStatus(connection, repository.root);
  expect(native.gitStatus).toHaveBeenCalledTimes(1);

  await invalidateRemoteGitQueries(connection, repository.root);
  expect(hasFreshGitStatus(connection, repository.root)).toBe(false);
  await loadRemoteGitStatus(connection, repository.root);
  expect(native.gitStatus).toHaveBeenCalledTimes(2);

  jest.advanceTimersByTime(GIT_STATE_STALE_TIME_MS);
  expect(hasFreshGitStatus(connection, repository.root)).toBe(false);
  await loadRemoteGitStatus(connection, repository.root);
  expect(native.gitStatus).toHaveBeenCalledTimes(3);
});

test('isolates repositories, reconnect generations, and replacement runtime instances', async () => {
  const { connection, native } = setup();
  await loadRemoteGitStatus(connection, repository.root);
  await loadRemoteGitStatus(connection, '/other');
  await loadRemoteGitStatus({ ...connection, generation: 2n }, repository.root);
  expect(native.gitStatus).toHaveBeenCalledTimes(3);
  const replacement = setup();
  await loadRemoteGitStatus(replacement.connection, repository.root);
  expect(replacement.native.gitStatus).toHaveBeenCalledTimes(1);
});

test('rejects an obsolete result instead of putting it in the cache', async () => {
  const { connection, native } = setup();
  let finish!: (changes: RemoteGitStatusEntry[]) => void;
  native.gitStatus.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = loadRemoteGitStatus(connection, repository.root);
  jest.mocked(connection.isCurrent).mockReturnValue(false);
  finish([status]);
  await expect(pending).rejects.toThrow('Host connection changed');
  expect(appQueryClient.getQueryData(gitStatusQueryOptions(connection, repository.root).queryKey)).toBeUndefined();
});

test('failed reads remain retryable without automatic native retries', async () => {
  const { connection, native } = setup();
  native.gitStatus.mockRejectedValueOnce(new Error('Disconnected'));
  await expect(loadRemoteGitStatus(connection, repository.root)).rejects.toThrow('Disconnected');
  expect(native.gitStatus).toHaveBeenCalledTimes(1);
  await expect(loadRemoteGitStatus(connection, repository.root)).resolves.toEqual([status]);
});

test('invalidation starts a fresh read and prevents an older response from restoring stale data', async () => {
  const { connection, native } = setup();
  let finishOld!: (changes: RemoteGitStatusEntry[]) => void;
  native.gitStatus.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  const obsolete = loadRemoteGitStatus(connection, repository.root).catch((reason: unknown) => reason);
  await invalidateRemoteGitQueries(connection, repository.root);
  expect(isCancelledError(await obsolete)).toBe(true);
  await loadRemoteGitStatus(connection, repository.root);
  expect(native.gitStatus).toHaveBeenCalledTimes(2);
  finishOld([]);
  await Promise.resolve();
  expect(appQueryClient.getQueryData(gitStatusQueryOptions(connection, repository.root).queryKey)).toEqual([status]);
});

test('shares discovery and diff reads only when their parameters match', async () => {
  const { connection, native } = setup();
  await Promise.all([
    discoverRemoteGitRepository(connection, repository.root),
    discoverRemoteGitRepository(connection, repository.root),
  ]);
  expect(native.discoverGitRepository).toHaveBeenCalledTimes(1);
  await Promise.all([
    loadRemoteGitDiff(connection, repository, status, 'compact'),
    loadRemoteGitDiff(connection, repository, status, 'compact'),
    loadRemoteGitDiff(connection, repository, status, 'full'),
    loadRemoteGitDiff(connection, repository, status, 'compact', [{ key: 'gap', before: 20, after: 0 }]),
  ]);
  expect(native.gitDiff).toHaveBeenCalledTimes(3);
});

test.each([repository, null])('caches discovery per directory for one minute, including %s', async result => {
  const { connection, native } = setup();
  native.discoverGitRepository.mockResolvedValue(result);
  await discoverRemoteGitRepository(connection, '/repo/child');
  jest.advanceTimersByTime(59_999);
  await expect(discoverRemoteGitRepository(connection, '/repo/child')).resolves.toEqual(result);
  expect(native.discoverGitRepository).toHaveBeenCalledTimes(1);
  await discoverRemoteGitRepository(connection, '/other');
  expect(native.discoverGitRepository).toHaveBeenCalledTimes(2);
  jest.advanceTimersByTime(1);
  await discoverRemoteGitRepository(connection, '/repo/child');
  expect(native.discoverGitRepository).toHaveBeenCalledTimes(3);
});

test('refreshing a repository invalidates its cached directory discoveries without invalidating other repositories', async () => {
  const { connection, native } = setup();
  await discoverRemoteGitRepository(connection, '/repo/child');
  native.discoverGitRepository.mockResolvedValueOnce({ root: '/other', hasHead: true });
  await discoverRemoteGitRepository(connection, '/other');
  await invalidateRemoteGitQueries(connection, repository.root);
  await discoverRemoteGitRepository(connection, '/repo/child');
  await discoverRemoteGitRepository(connection, '/other');
  expect(native.discoverGitRepository).toHaveBeenCalledTimes(3);
});

test('refreshing a repository discards pending discovery in its subdirectories', async () => {
  const { connection, native } = setup();
  let finish!: (value: typeof repository | null) => void;
  native.discoverGitRepository.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const obsolete = discoverRemoteGitRepository(connection, '/repo/child').catch((reason: unknown) => reason);
  await invalidateRemoteGitQueries(connection, repository.root);
  expect(isCancelledError(await obsolete)).toBe(true);
  await expect(discoverRemoteGitRepository(connection, '/repo/child')).resolves.toEqual(repository);
  finish(null);
  await expect(discoverRemoteGitRepository(connection, '/repo/child')).resolves.toEqual(repository);
  expect(native.discoverGitRepository).toHaveBeenCalledTimes(2);
});

test('status invalidation allows an already opening diff viewer to finish', async () => {
  const { connection, native } = setup();
  let finish!: (value: RemoteGitDiff) => void;
  native.gitDiff.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = loadRemoteGitDiff(connection, repository, status, 'compact');
  await invalidateRemoteGitQueries(connection, repository.root);
  finish(diff);
  await expect(pending).resolves.toBe(diff);
});

test('keeps working tree and different commit diffs separate while sharing identical reads', async () => {
  const { connection, native } = setup();
  await Promise.all([
    loadRemoteGitDiff(connection, repository, status, 'compact'),
    loadRemoteGitDiff(connection, repository, status, 'compact', [], 'first'),
    loadRemoteGitDiff(connection, repository, status, 'compact', [], 'first'),
    loadRemoteGitDiff(connection, repository, status, 'compact', [], 'second'),
  ]);
  expect(native.gitDiff).toHaveBeenCalledTimes(3);
  await Promise.all([
    appQueryClient.fetchQuery(gitCommitFilesQueryOptions(connection, repository.root, 'first')),
    appQueryClient.fetchQuery(gitCommitFilesQueryOptions(connection, repository.root, 'second')),
    appQueryClient.fetchQuery(gitCommitFilesQueryOptions(connection, repository.root, 'first')),
  ]);
  expect(native.gitCommitFiles).toHaveBeenCalledTimes(2);
});

test('rejects history from an obsolete connection instead of caching it', async () => {
  const { connection, native } = setup();
  let finish!: (value: { branch: string; commits: [] }) => void;
  native.gitSummary.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const options = gitSummaryQueryOptions(connection, repository.root);
  const pending = appQueryClient.fetchInfiniteQuery(options);
  jest.mocked(connection.isCurrent).mockReturnValue(false);
  finish({ branch: 'old', commits: [] });
  await expect(pending).rejects.toThrow('Host connection changed');
  expect(appQueryClient.getQueryData(options.queryKey)).toBeUndefined();
});
