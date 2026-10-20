jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getAllKeys: jest.fn(), multiGet: jest.fn() },
}));
jest.mock('react-native-whip-ssh', () => ({
  appDataMigrationComplete: jest.fn(), importLegacyAppData: jest.fn(),
  readAppData: jest.fn(), writeAppData: jest.fn(), selectLegacyAppDataKeys: jest.fn(),
}));
import LegacyStorage from '@react-native-async-storage/async-storage';
import { appDataMigrationComplete, importLegacyAppData, readAppData, writeAppData, selectLegacyAppDataKeys } from 'react-native-whip-ssh';
import { AppStorage } from '../src/services/appStorage';
const native = { appDataMigrationComplete: jest.mocked(appDataMigrationComplete), importLegacyAppData: jest.mocked(importLegacyAppData), readAppData: jest.mocked(readAppData), writeAppData: jest.mocked(writeAppData) };
const TRUST = 'herdr.known-hosts.v1';

beforeEach(() => {
  jest.resetAllMocks();
  native.appDataMigrationComplete.mockResolvedValue(false);
  jest.mocked(selectLegacyAppDataKeys).mockImplementation(keys => keys.filter(key => key.startsWith('herdr.')));
  jest.mocked(LegacyStorage.getAllKeys).mockResolvedValue([TRUST, 'third-party-key']);
  jest.mocked(LegacyStorage.multiGet).mockResolvedValue([[TRUST, 'old trust']]);
  native.readAppData.mockImplementation(async keys => keys.map(key => ({ key, value: 'persisted' })));
  native.writeAppData.mockResolvedValue(undefined);
  native.importLegacyAppData.mockResolvedValue(undefined);
});

test('imports a complete legacy snapshot once before concurrent consumers and startup batch', async () => {
  const storage = new AppStorage();
  await Promise.all([storage.multiGet([TRUST, 'herdr.hosts.v2']), storage.setItem('herdr.live.hosts.v1', '{}')]);
  expect(LegacyStorage.getAllKeys).toHaveBeenCalledTimes(1);
  expect(LegacyStorage.multiGet).toHaveBeenCalledWith([TRUST]);
  expect(native.importLegacyAppData).toHaveBeenCalledWith([{ key: TRUST, value: 'old trust' }]);
  expect(native.readAppData).toHaveBeenCalledWith([TRUST, 'herdr.hosts.v2']);
  expect(native.importLegacyAppData.mock.invocationCallOrder[0]).toBeLessThan(native.readAppData.mock.invocationCallOrder[0]);
});

test('a receipt skips the legacy store, including after values were deleted', async () => {
  native.appDataMigrationComplete.mockResolvedValue(true);
  await new AppStorage().removeItem(TRUST);
  expect(LegacyStorage.getAllKeys).not.toHaveBeenCalled();
  expect(native.importLegacyAppData).not.toHaveBeenCalled();
  expect(native.writeAppData).toHaveBeenCalledWith([{ key: TRUST, value: undefined }]);
});

test.each(['missing', 'null', 'read failure', 'commit failure'])('failed import (%s) blocks writes and retries without an empty fallback', async mode => {
  if (mode === 'missing') jest.mocked(LegacyStorage.multiGet).mockResolvedValueOnce([]);
  if (mode === 'null') jest.mocked(LegacyStorage.multiGet).mockResolvedValueOnce([[TRUST, null]]);
  if (mode === 'read failure') jest.mocked(LegacyStorage.getAllKeys).mockRejectedValueOnce(new Error('legacy read failed'));
  if (mode === 'commit failure') native.importLegacyAppData.mockRejectedValueOnce(new Error('commit failed'));
  const storage = new AppStorage();
  await expect(storage.setItem(TRUST, 'new trust')).rejects.toThrow();
  expect(native.writeAppData).not.toHaveBeenCalled();
  await storage.setItem(TRUST, 'new trust');
  expect(native.writeAppData).toHaveBeenCalledTimes(1);
});

test('serializes writes, deletes and reads through committed completion, and recovers after failure', async () => {
  native.appDataMigrationComplete.mockResolvedValue(true);
  let finish!: () => void;
  native.writeAppData.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const storage = new AppStorage();
  const first = storage.setItem(TRUST, 'first');
  const second = storage.removeItem(TRUST);
  const read = storage.getItem(TRUST);
  for (let n = 0; n < 10; n++) await Promise.resolve();
  expect(native.writeAppData).toHaveBeenCalledTimes(1);
  expect(native.readAppData).not.toHaveBeenCalled();
  finish();
  await Promise.all([first, second, read]);
  expect(native.writeAppData.mock.calls).toEqual([[[{ key: TRUST, value: 'first' }]], [[{ key: TRUST, value: undefined }]]]);
  native.writeAppData.mockRejectedValueOnce(new Error('disk full'));
  await expect(storage.setItem(TRUST, 'failed')).rejects.toThrow('disk full');
  await storage.setItem(TRUST, 'retry');
});

test('rejects incomplete native snapshots and never reads old values as fallback', async () => {
  native.appDataMigrationComplete.mockResolvedValue(true);
  native.readAppData.mockResolvedValueOnce([]);
  await expect(new AppStorage().getItem(TRUST)).rejects.toThrow('incomplete snapshot');
  expect(LegacyStorage.multiGet).not.toHaveBeenCalled();
});

test('coalesces adjacent reads, with writes acting as ordering barriers', async () => {
  native.appDataMigrationComplete.mockResolvedValue(true);
  const storage = new AppStorage();
  const first = storage.getItem('first');
  const second = storage.getItem('second');
  const write = storage.setItem('first', 'changed');
  const after = storage.getItem('first');
  await expect(Promise.all([first, second, write, after])).resolves.toEqual(['persisted', 'persisted', undefined, 'persisted']);
  expect(native.readAppData.mock.calls).toEqual([[['first', 'second']], [['first']]]);
});

test('a new installation records an empty import without a legacy multi-read', async () => {
  jest.mocked(LegacyStorage.getAllKeys).mockResolvedValue([]);
  await new AppStorage().getItem(TRUST);
  expect(LegacyStorage.multiGet).not.toHaveBeenCalled();
  expect(native.importLegacyAppData).toHaveBeenCalledWith([]);
});

test('failed initialization clears a coalesced read batch so the next read can retry', async () => {
  native.appDataMigrationComplete.mockRejectedValueOnce(new Error('database unavailable'));
  const storage = new AppStorage();
  const first = storage.getItem(TRUST);
  const second = storage.getItem('herdr.hosts.v2');
  const failures = await Promise.allSettled([first, second]);
  expect(failures.every(result => result.status === 'rejected')).toBe(true);
  expect(native.readAppData).not.toHaveBeenCalled();
  await expect(storage.getItem(TRUST)).resolves.toBe('persisted');
  expect(native.readAppData).toHaveBeenCalledWith([TRUST]);
});
