import {
  discoverRemoteGitRepository,
  GIT_STATUS_STALE_TIME_MS,
  gitStatusQueryOptions,
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

  jest.advanceTimersByTime(GIT_STATUS_STALE_TIME_MS);
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

test('status invalidation allows an already opening diff viewer to finish', async () => {
  const { connection, native } = setup();
  let finish!: (value: RemoteGitDiff) => void;
  native.gitDiff.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = loadRemoteGitDiff(connection, repository, status, 'compact');
  await invalidateRemoteGitQueries(connection, repository.root);
  finish(diff);
  await expect(pending).resolves.toBe(diff);
});
