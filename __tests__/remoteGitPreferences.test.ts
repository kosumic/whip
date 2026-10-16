import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  REMOTE_GIT_PREFERENCES_KEY,
  REMOTE_GIT_TREE_PREFERENCES_KEY,
  loadRemoteGitCollapsedPaths,
  loadRemoteGitMode,
  saveRemoteGitCollapsedPaths,
  saveRemoteGitMode,
} from '../src/services/remoteGitPreferences';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
  },
}));

const getItem = AsyncStorage.getItem as jest.MockedFunction<
  typeof AsyncStorage.getItem
>;
const setItem = AsyncStorage.setItem as jest.MockedFunction<
  typeof AsyncStorage.setItem
>;

beforeEach(() => {
  jest.clearAllMocks();
  getItem.mockReset();
  setItem.mockReset().mockResolvedValue(undefined);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it('loads the mode only for the matching host and canonical repository root', async () => {
  getItem.mockResolvedValue(
    JSON.stringify([
      { hostId: 'host-a', root: '/repo', updatedAt: 2 },
      { hostId: 'host-b', root: '/other', updatedAt: 1 },
    ]),
  );

  await expect(loadRemoteGitMode('host-a', '/repo')).resolves.toBe(true);
  await expect(loadRemoteGitMode('host-a', '/other')).resolves.toBe(false);
  expect(getItem).toHaveBeenCalledWith(REMOTE_GIT_PREFERENCES_KEY);
});

it('diagnoses malformed persisted data instead of treating it as disabled', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  getItem.mockResolvedValue('{broken');

  await expect(loadRemoteGitMode('host-a', '/repo')).rejects.toBeInstanceOf(SyntaxError);
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('storage-parse-failed'));
  consoleError.mockRestore();
});

it('persists enabled repositories and removes disabled repositories', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(1234);
  getItem
    .mockResolvedValueOnce(
      JSON.stringify([{ hostId: 'host-b', root: '/other', updatedAt: 2 }]),
    )
    .mockResolvedValueOnce(
      JSON.stringify([
        { hostId: 'host-a', root: '/repo', updatedAt: 3 },
        { hostId: 'host-b', root: '/other', updatedAt: 2 },
      ]),
    );

  await saveRemoteGitMode('host-a', '/repo', true);
  await saveRemoteGitMode('host-a', '/repo', false);

  expect(setItem).toHaveBeenNthCalledWith(
    1,
    REMOTE_GIT_PREFERENCES_KEY,
    JSON.stringify([
      { hostId: 'host-a', root: '/repo', updatedAt: 1234 },
      { hostId: 'host-b', root: '/other', updatedAt: 2 },
    ]),
  );
  expect(setItem).toHaveBeenNthCalledWith(
    2,
    REMOTE_GIT_PREFERENCES_KEY,
    JSON.stringify([{ hostId: 'host-b', root: '/other', updatedAt: 2 }]),
  );
  jest.restoreAllMocks();
});

it('persists collapsed directories per host and repository', async () => {
  getItem
    .mockResolvedValueOnce(
      JSON.stringify([
        {
          hostId: 'host-a',
          root: '/repo',
          collapsedPaths: ['src', 'packages/app'],
          updatedAt: 2,
        },
      ]),
    )
    .mockResolvedValueOnce('[]');

  await expect(loadRemoteGitCollapsedPaths('host-a', '/repo')).resolves.toEqual(
    ['src', 'packages/app'],
  );
  await saveRemoteGitCollapsedPaths('host-a', '/repo', ['src', 'src']);

  expect(getItem).toHaveBeenNthCalledWith(1, REMOTE_GIT_TREE_PREFERENCES_KEY);
  expect(setItem).toHaveBeenCalledWith(
    REMOTE_GIT_TREE_PREFERENCES_KEY,
    expect.stringContaining('"collapsedPaths":["src"]'),
  );
});

it('does not overwrite repository preferences after a transient read failure', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const readError = new Error('AsyncStorage unavailable');
  getItem.mockRejectedValueOnce(readError);

  await expect(saveRemoteGitMode('host-a', '/repo', true)).rejects.toBe(readError);

  expect(setItem).not.toHaveBeenCalled();
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('storage-read-failed'));
  consoleError.mockRestore();
});

it('does not overwrite tree preferences after corrupted state is read', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  getItem.mockResolvedValueOnce('{broken');

  await expect(saveRemoteGitCollapsedPaths('host-a', '/repo', ['src']))
    .rejects.toBeInstanceOf(SyntaxError);

  expect(setItem).not.toHaveBeenCalled();
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('storage-parse-failed'));
  consoleError.mockRestore();
});

it('orders tree snapshots and preserves other repositories while a write is pending', async () => {
  const stored = new Map<string, string>();
  const started = deferred<undefined>();
  const release = deferred<undefined>();
  getItem.mockImplementation(async key => stored.get(key) ?? null);
  setItem.mockImplementation(async (key, value) => {
    if (setItem.mock.calls.length === 1) {
      started.resolve(undefined);
      await release.promise;
    }
    stored.set(key, value);
  });

  const first = saveRemoteGitCollapsedPaths('host-a', '/repo', ['src']);
  const paths = ['src', 'lib'];
  const latest = saveRemoteGitCollapsedPaths('host-a', '/repo', paths);
  paths.push('not part of the saved snapshot');
  const other = saveRemoteGitCollapsedPaths('host-b', '/other', ['docs']);
  const restored = loadRemoteGitCollapsedPaths('host-a', '/repo');
  await started.promise;

  // A second read before this write finishes would observe the old JSON array.
  expect(getItem).toHaveBeenCalledTimes(1);
  expect(setItem).toHaveBeenCalledTimes(1);
  release.resolve(undefined);
  await Promise.all([first, latest, other]);

  await expect(restored).resolves.toEqual(['src', 'lib']);
  await expect(loadRemoteGitCollapsedPaths('host-b', '/other')).resolves.toEqual(['docs']);
});

it('preserves other repositories when Git mode changes overlap', async () => {
  const stored = new Map<string, string>();
  getItem.mockImplementation(async key => stored.get(key) ?? null);
  setItem.mockImplementation(async (key, value) => { stored.set(key, value); });

  const writes = [
    saveRemoteGitMode('host-a', '/repo', true),
    saveRemoteGitMode('host-b', '/other', true),
    saveRemoteGitMode('host-a', '/repo', false),
  ];
  const restored = loadRemoteGitMode('host-b', '/other');
  await Promise.all(writes);

  await expect(restored).resolves.toBe(true);
  await expect(loadRemoteGitMode('host-a', '/repo')).resolves.toBe(false);
});

it.each(['read', 'write'] as const)('continues queued mutations after a %s failure', async phase => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const failure = new Error(`Storage ${phase} failed`);
  const stored = new Map<string, string>();
  getItem.mockImplementation(async key => stored.get(key) ?? null);
  setItem.mockImplementation(async (key, value) => { stored.set(key, value); });
  if (phase === 'read') getItem.mockRejectedValueOnce(failure);
  else setItem.mockRejectedValueOnce(failure);

  const failed = saveRemoteGitCollapsedPaths('host-a', '/repo', ['src']);
  const next = saveRemoteGitCollapsedPaths('host-b', '/other', ['docs']);
  await expect(Promise.allSettled([failed, next])).resolves.toEqual([
    { status: 'rejected', reason: failure },
    { status: 'fulfilled', value: undefined },
  ]);

  await expect(loadRemoteGitCollapsedPaths('host-a', '/repo')).resolves.toEqual([]);
  await expect(loadRemoteGitCollapsedPaths('host-b', '/other')).resolves.toEqual(['docs']);
  consoleError.mockRestore();
});
