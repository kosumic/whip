jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn() },
}));
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadPersistedTerminals,
  PersistedTerminalsWriter,
  savePersistedTerminals,
} from '../src/services/persistedTerminals';

const getItem = jest.mocked(AsyncStorage.getItem);
const setItem = jest.mocked(AsyncStorage.setItem);
const RESUME_KEY = 'herdr.terminal.sessions.v1.host';
const FONT_KEY = 'herdr.terminal.font-sizes.v1.host';

beforeEach(() => {
  getItem.mockReset().mockResolvedValue(null);
  setItem.mockReset().mockResolvedValue(undefined);
});

test('passes the native resume through storage without interpreting it', async () => {
  const blob = 'opaque native value';
  getItem.mockImplementation(async key => (key === RESUME_KEY ? blob : '{}'));
  await expect(loadPersistedTerminals('host')).resolves.toEqual({
    resumeBlob: blob,
    fontSizes: new Map(),
  });
  await savePersistedTerminals('host', blob);
  expect(setItem).toHaveBeenCalledWith(RESUME_KEY, blob);
});

test('extracts only font preferences from legacy terminal records', async () => {
  const legacy = JSON.stringify({
    activeTerminalId: 'term',
    sessions: [
      {
        terminalId: 'term',
        paneId: 'old-pane',
        title: 'old-title',
        fontSize: 10,
      },
      { terminalId: 'large', fontSize: 100 },
      { terminalId: 'bad', fontSize: 'no' },
      null,
    ],
  });
  getItem.mockImplementation(async key => (key === RESUME_KEY ? legacy : null));
  const restored = await loadPersistedTerminals('host');
  expect(restored.resumeBlob).toBe(legacy);
  expect(restored.fontSizes).toEqual(
    new Map([
      ['term', 10],
      ['large', 24],
    ]),
  );
});

test('prefers separately stored fonts over legacy values', async () => {
  const legacy = JSON.stringify({
    sessions: [{ terminalId: 'term', fontSize: 10 }],
  });
  getItem.mockImplementation(async key =>
    key === RESUME_KEY ? legacy : '{"term":12}',
  );
  expect((await loadPersistedTerminals('host')).fontSizes.get('term')).toBe(12);
});

test('writes presentation fonts before migrating the opaque resume', async () => {
  const writer = new PersistedTerminalsWriter();
  await writer.saveIfChanged(
    'live',
    'host',
    'native resume',
    new Map([['term', 11]]),
  );
  expect(setItem.mock.calls).toEqual([
    [FONT_KEY, '{"term":11}'],
    [RESUME_KEY, 'native resume'],
  ]);
});

test('skips unchanged resume and font values across new projections', async () => {
  const writer = new PersistedTerminalsWriter();
  await writer.saveIfChanged('live', 'host', 'resume', new Map([['term', 10]]));
  setItem.mockClear();
  await expect(
    writer.saveIfChanged('live', 'host', 'resume', new Map([['term', 10]])),
  ).resolves.toBe(false);
  expect(setItem).not.toHaveBeenCalled();
  await writer.saveIfChanged('live', 'host', 'resume', new Map([['term', 11]]));
  expect(setItem.mock.calls).toEqual([[FONT_KEY, '{"term":11}']]);
});

test('serializes saves so an earlier native resume cannot overwrite the latest one', async () => {
  let finish!: () => void;
  setItem.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = () => resolve();
      }),
  );
  const writer = new PersistedTerminalsWriter();
  const first = writer.saveIfChanged('live', 'host', 'first', new Map());
  const second = writer.saveIfChanged('live', 'host', 'second', new Map());
  await Promise.resolve();
  await Promise.resolve();
  expect(setItem).toHaveBeenCalledTimes(1);
  finish();
  await Promise.all([first, second]);
  expect(setItem.mock.calls).toEqual([
    [FONT_KEY, '{}'],
    [RESUME_KEY, 'first'],
    [RESUME_KEY, 'second'],
  ]);
});

test('retries the same value after a failed write', async () => {
  const error = new Error('write unavailable');
  const log = jest.spyOn(console, 'error').mockImplementation();
  setItem.mockRejectedValueOnce(error);
  const writer = new PersistedTerminalsWriter();
  await expect(
    writer.saveIfChanged('live', 'host', 'resume', new Map()),
  ).rejects.toBe(error);
  await expect(
    writer.saveIfChanged('live', 'host', 'resume', new Map()),
  ).resolves.toBe(true);
  expect(setItem).toHaveBeenLastCalledWith(RESUME_KEY, 'resume');
  log.mockRestore();
});

test('propagates storage read failures with diagnostics', async () => {
  const error = new Error('read unavailable');
  const log = jest.spyOn(console, 'error').mockImplementation();
  getItem.mockRejectedValueOnce(error);
  await expect(loadPersistedTerminals('host')).rejects.toBe(error);
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining('storage-read-failed'),
  );
  log.mockRestore();
});

test('malformed fonts fall back without changing the opaque resume', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation();
  getItem.mockImplementation(async key =>
    key === RESUME_KEY ? 'native resume' : '{invalid',
  );
  await expect(loadPersistedTerminals('host')).resolves.toEqual({
    resumeBlob: 'native resume',
    fontSizes: new Map(),
  });
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining('storage-parse-failed'),
  );
  log.mockRestore();
});

test('diagnostics do not expose the opaque resume on write failure', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation();
  setItem.mockRejectedValueOnce(new Error('write unavailable'));
  await expect(
    savePersistedTerminals('host', 'sensitive resume'),
  ).rejects.toThrow('write unavailable');
  expect(String(log.mock.calls[0]?.[0])).not.toContain('sensitive resume');
  log.mockRestore();
});
