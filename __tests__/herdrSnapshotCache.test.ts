jest.mock('../src/services/appStorage', () => ({
  __esModule: true,
  appStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

import { appStorage } from '../src/services/appStorage';

import { HerdrSnapshotCache } from '../src/services/herdrSnapshotCache';

function source(blob = 'opaque Rust cache', runtimeIncarnation = 1) {
  const state = { revision: 1, blob };
  return {
    state,
    runtimeIncarnation,
    exportOfflineCache: jest.fn(async (lastRevision?: number) =>
      lastRevision === state.revision ? undefined : { ...state }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('offline Herdr snapshot cache', () => {
  const stored = new Map<string, string>();

  beforeEach(() => {
    jest.useFakeTimers();
    stored.clear();
    jest.mocked(appStorage.getItem).mockImplementation(async key => stored.get(key) ?? null);
    jest.mocked(appStorage.setItem).mockImplementation(async (key, value) => { stored.set(key, value); });
    jest.mocked(appStorage.removeItem).mockImplementation(async key => { stored.delete(key); });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('coalesces ten batches into one export of the latest native state', async () => {
    const cache = new HerdrSnapshotCache();
    const latest = '  opaque Rust cache\n';
    const native = source('earlier blob');
    for (let revision = 1; revision <= 10; revision += 1) {
      native.state.revision = revision;
      cache.schedule('host', native);
    }
    native.state.blob = latest;
    expect(native.exportOfflineCache).not.toHaveBeenCalled();
    expect(appStorage.setItem).not.toHaveBeenCalled();

    jest.runAllTimers();
    expect(await cache.load('host')).toBe(latest);
    expect(appStorage.setItem).toHaveBeenCalledWith('herdr.host.snapshot.v1.host', latest);
    expect(appStorage.setItem).toHaveBeenCalledTimes(1);
    expect(native.exportOfflineCache).toHaveBeenCalledTimes(1);
    expect(native.exportOfflineCache).toHaveBeenCalledWith(undefined);
  });

  test('deletion cancels a pending write', async () => {
    const cache = new HerdrSnapshotCache();
    const native = source('pending blob');
    cache.schedule('host', native);
    await cache.delete('host');
    jest.runAllTimers();
    expect(await cache.load('host')).toBeNull();
    expect(appStorage.setItem).not.toHaveBeenCalled();
    expect(native.exportOfflineCache).not.toHaveBeenCalled();
  });

  test('passes malformed stored data to Rust without projecting it in JS', async () => {
    stored.set('herdr.host.snapshot.v1.host', '{invalid');
    expect(await new HerdrSnapshotCache().load('host')).toBe('{invalid');
  });

  test('stores each host independently without interpreting empty blobs', async () => {
    const cache = new HerdrSnapshotCache();
    cache.schedule('first', source('first blob'));
    cache.schedule('second', source(''));
    jest.runAllTimers();
    expect(await cache.load('first')).toBe('first blob');
    expect(await cache.load('second')).toBe('');
  });

  test('flush bypasses the delay and skips revisions already committed', async () => {
    const cache = new HerdrSnapshotCache();
    const native = source();
    cache.schedule('host', native);
    await cache.flush();
    cache.schedule('host', native);
    await cache.flush('host');
    expect(native.exportOfflineCache.mock.calls).toEqual([[undefined], [1]]);
    expect(appStorage.setItem).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('uses a new revision cursor when the native runtime is replaced', async () => {
    const cache = new HerdrSnapshotCache();
    const original = source('original', 1);
    const replacement = source('replacement', 2);
    cache.schedule('host', original);
    await cache.flush();
    cache.schedule('host', replacement);
    await cache.flush();
    expect(replacement.exportOfflineCache).toHaveBeenCalledWith(undefined);
    expect(await cache.load('host')).toBe('replacement');
  });

  test('serializes exports and preserves updates arriving during a write', async () => {
    const cache = new HerdrSnapshotCache();
    const native = source('first');
    const writing = deferred<undefined>();
    const started = deferred<undefined>();
    jest.mocked(appStorage.setItem).mockImplementationOnce(async (key, value) => {
      started.resolve(undefined);
      await writing.promise;
      stored.set(key, value);
    });
    cache.schedule('host', native);
    const first = cache.flush();
    await started.promise;
    native.state = { revision: 2, blob: 'latest' };
    // The exporter owns the same mutable native state throughout.
    native.exportOfflineCache.mockImplementation(async lastRevision =>
      lastRevision === native.state.revision ? undefined : { ...native.state });
    cache.schedule('host', native);
    const second = cache.flush();
    expect(native.exportOfflineCache).toHaveBeenCalledTimes(1);
    writing.resolve(undefined);
    await Promise.all([first, second]);
    expect(native.exportOfflineCache.mock.calls).toEqual([[undefined], [1]]);
    expect(await cache.load('host')).toBe('latest');
  });

  test('deletion waits for an in-flight export and prevents cache resurrection', async () => {
    const cache = new HerdrSnapshotCache();
    const native = source();
    const exporting = deferred<{ revision: number; blob: string }>();
    const started = deferred<undefined>();
    native.exportOfflineCache.mockImplementationOnce(() => {
      started.resolve(undefined);
      return exporting.promise;
    });
    cache.schedule('host', native);
    const write = cache.flush('host');
    await started.promise;
    const removal = cache.delete('host');
    expect(appStorage.removeItem).not.toHaveBeenCalled();
    exporting.resolve({ ...native.state });
    await Promise.all([write, removal]);
    expect(await cache.load('host')).toBeNull();
    cache.schedule('host', native);
    await cache.flush();
    expect(native.exportOfflineCache).toHaveBeenLastCalledWith(undefined);
    expect(await cache.load('host')).toBe(native.state.blob);
  });

  test.each(['export', 'write'])('retries the same revision after a failed %s', async failure => {
    const cache = new HerdrSnapshotCache();
    const native = source();
    const error = new Error('cache unavailable');
    if (failure === 'export') native.exportOfflineCache.mockRejectedValueOnce(error);
    else jest.mocked(appStorage.setItem).mockRejectedValueOnce(error);
    cache.schedule('host', native);
    await expect(cache.flush()).rejects.toThrow('cache unavailable');
    cache.schedule('host', native);
    await cache.flush();
    expect(native.exportOfflineCache.mock.calls).toEqual([[undefined], [undefined]]);
    expect(await cache.load('host')).toBe(native.state.blob);
  });
});
