import { BrowserSearchHistory } from '../src/browser/searchHistory';

const mockNative = {
  record: jest.fn(),
  remove: jest.fn(),
  clear: jest.fn(),
  suggestions: jest.fn(() => ['rust']),
  snapshot: jest.fn(() => '["rust"]'),
};
const mockConstruct = jest.fn();
jest.mock('react-native-whip-ssh', () => ({
  BrowserSearchHistory: jest.fn((snapshot: string) => {
    mockConstruct(snapshot);
    return mockNative;
  }),
}));

beforeEach(() => jest.clearAllMocks());

test('mutations wait for persisted history to hydrate, then notify and persist native snapshots', async () => {
  let finish!: (value: string) => void;
  const storage = {
    getItem: jest.fn(
      () =>
        new Promise<string>(resolve => {
          finish = resolve;
        }),
    ),
    setItem: jest.fn(async () => undefined),
  };
  const history = new BrowserSearchHistory(storage);
  const changed = jest.fn();
  const unsubscribe = history.subscribe(changed);
  const record = history.record('rust');
  expect(mockNative.record).not.toHaveBeenCalled();
  finish('["old search"]');
  await record;
  expect(mockConstruct).toHaveBeenCalledWith('["old search"]');
  expect(mockNative.record).toHaveBeenCalledWith('rust');
  expect(storage.setItem).toHaveBeenCalledWith(
    'whip.browser.search-history.v1',
    '["rust"]',
  );
  expect(changed).toHaveBeenCalledTimes(2);
  expect(history.suggestions('ru')).toEqual(['rust']);
  expect(mockNative.suggestions).toHaveBeenCalledWith('ru');
  await history.remove('rust');
  expect(mockNative.remove).toHaveBeenCalledWith('rust');
  unsubscribe();
  await history.clear();
  expect(mockNative.clear).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledTimes(3);
  expect(storage.getItem).toHaveBeenCalledTimes(1);
});

test('queued writes recover from a disk failure and preserve newer search snapshots', async () => {
  const storage = {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
  };
  storage.setItem.mockRejectedValueOnce(new Error('disk full'));
  const history = new BrowserSearchHistory(storage);
  await expect(history.record('rust')).rejects.toThrow('disk full');
  mockNative.snapshot.mockReturnValueOnce('[]');
  await history.clear();
  expect(storage.setItem).toHaveBeenLastCalledWith(
    'whip.browser.search-history.v1',
    '[]',
  );
});

test('read failure can be retried without replacing saved history', async () => {
  const storage = {
    getItem: jest.fn(async () => '["saved"]'),
    setItem: jest.fn(async () => undefined),
  };
  storage.getItem.mockRejectedValueOnce(new Error('storage unavailable'));
  const history = new BrowserSearchHistory(storage);
  await expect(history.load()).rejects.toThrow('storage unavailable');
  expect(mockConstruct).not.toHaveBeenCalled();
  await history.load();
  expect(mockConstruct).toHaveBeenCalledWith('["saved"]');
  expect(storage.setItem).not.toHaveBeenCalled();
});
