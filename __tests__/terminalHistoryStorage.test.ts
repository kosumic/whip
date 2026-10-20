jest.mock('../src/services/appStorage', () => ({
  __esModule: true,
  appStorage: { getItem: jest.fn(), setItem: jest.fn() },
}));

import { appStorage } from '../src/services/appStorage';

import {
  loadTerminalHistory,
  saveTerminalHistory,
  TERMINAL_HISTORY_STORAGE_KEY,
} from '../src/services/terminalHistory';

const mockGetItem = jest.mocked(appStorage.getItem);
const mockSetItem = jest.mocked(appStorage.setItem);

beforeEach(() => {
  mockGetItem.mockReset();
  mockSetItem.mockReset();
});

test('loads valid unique terminal history entries', async () => {
  mockGetItem.mockResolvedValue(JSON.stringify(['newest', '', 'older', 'newest', 42]));

  await expect(loadTerminalHistory()).resolves.toEqual(['newest', 'older']);
  expect(mockGetItem).toHaveBeenCalledWith(TERMINAL_HISTORY_STORAGE_KEY);
});

test('recovers from malformed terminal history', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  mockGetItem.mockResolvedValue('{not json');
  await expect(loadTerminalHistory()).resolves.toEqual([]);
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '[StorageDiagnostics] storage-parse-failed',
  ));
  consoleError.mockRestore();
});

test('saves normalized terminal history', async () => {
  await saveTerminalHistory(['newest', 'older', 'newest']);

  expect(mockSetItem).toHaveBeenCalledWith(
    TERMINAL_HISTORY_STORAGE_KEY,
    JSON.stringify(['newest', 'older']),
  );
});

test('logs terminal history read failure while preserving the startup fallback', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  mockGetItem.mockRejectedValueOnce(new Error('read unavailable'));

  const history = await loadTerminalHistory().catch(() => []);

  expect(history).toEqual([]);
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '[StorageDiagnostics] storage-read-failed',
  ));
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '"store":"terminal-history"',
  ));
  consoleError.mockRestore();
});

test('logs terminal history write rejection', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const error = new Error('write unavailable');
  mockSetItem.mockRejectedValueOnce(error);

  await expect(saveTerminalHistory(['private command'])).rejects.toBe(error);

  const diagnostic = String(consoleError.mock.calls[0]?.[0]);
  expect(diagnostic).toContain('[StorageDiagnostics] storage-write-failed');
  expect(diagnostic).not.toContain('private command');
  consoleError.mockRestore();
});
