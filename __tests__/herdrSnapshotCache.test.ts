const mockNative = {
  scheduleSnapshot: jest.fn(),
  flush: jest.fn(() => ({ wait: jest.fn().mockResolvedValue(true) })),
  readSnapshot: jest.fn(() => ({
    snapshot: jest.fn().mockResolvedValue('opaque Rust cache'),
  })),
  deleteSnapshot: jest.fn(() => ({ wait: jest.fn().mockResolvedValue(true) })),
};
jest.mock('../src/services/sessionPersistence', () => ({
  sessionPersistence: () => mockNative,
  sessionPersistenceEffect: (effect: () => Promise<unknown>) => effect(),
}));
import { HerdrSnapshotCache } from '../src/services/herdrSnapshotCache';
beforeEach(() => jest.clearAllMocks());

test('passes the native runtime identity without exporting or scheduling in JavaScript', async () => {
  const cache = new HerdrSnapshotCache();
  cache.schedule('host', { runtimeId: 'runtime', runtimeIncarnation: 7 });
  expect(mockNative.scheduleSnapshot).toHaveBeenCalledWith(
    'host',
    'runtime',
    7n,
  );
  await cache.flush('host');
  expect(mockNative.flush).toHaveBeenCalledWith('host');
  expect(await cache.load('host')).toBe('opaque Rust cache');
  expect(mockNative.readSnapshot).toHaveBeenCalledWith('host');
  await cache.delete('host');
  expect(mockNative.deleteSnapshot).toHaveBeenCalledWith('host');
});

test('native flush failures reach the lifecycle caller', async () => {
  mockNative.flush.mockReturnValueOnce({
    wait: jest.fn().mockRejectedValue(new Error('write failed')),
  });
  await expect(new HerdrSnapshotCache().flush()).rejects.toThrow(
    'write failed',
  );
});
