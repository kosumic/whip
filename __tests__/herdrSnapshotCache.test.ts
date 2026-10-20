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

  test('coalesces updates and stores the latest opaque blob unchanged', async () => {
    const cache = new HerdrSnapshotCache();
    const latest = '  opaque Rust cache\n';
    cache.schedule('host', 'earlier blob');
    cache.schedule('host', latest);
    expect(appStorage.setItem).not.toHaveBeenCalled();

    jest.runAllTimers();
    expect(await cache.load('host')).toBe(latest);
    expect(appStorage.setItem).toHaveBeenCalledWith('herdr.host.snapshot.v1.host', latest);
    expect(appStorage.setItem).toHaveBeenCalledTimes(1);
  });

  test('deletion cancels a pending write', async () => {
    const cache = new HerdrSnapshotCache();
    cache.schedule('host', 'pending blob');
    await cache.delete('host');
    jest.runAllTimers();
    expect(await cache.load('host')).toBeNull();
    expect(appStorage.setItem).not.toHaveBeenCalled();
  });

  test('passes malformed stored data to Rust without projecting it in JS', async () => {
    stored.set('herdr.host.snapshot.v1.host', '{invalid');
    expect(await new HerdrSnapshotCache().load('host')).toBe('{invalid');
  });

  test('stores each host independently without interpreting empty blobs', async () => {
    const cache = new HerdrSnapshotCache();
    cache.schedule('first', 'first blob');
    cache.schedule('second', '');
    jest.runAllTimers();
    expect(await cache.load('first')).toBe('first blob');
    expect(await cache.load('second')).toBe('');
  });
});
