jest.mock('../src/services/appStorage', () => ({
  appStorage: { multiGet: jest.fn(), multiSet: jest.fn(), setItem: jest.fn() },
}));
import { appStorage } from '../src/services/appStorage';
import { loadPersistedTerminals, PersistedTerminalsWriter, savePersistedTerminals } from '../src/services/persistedTerminals';
const multiGet = jest.mocked(appStorage.multiGet);
const multiSet = jest.mocked(appStorage.multiSet);
const setItem = jest.mocked(appStorage.setItem);
const RESUME_KEY = 'herdr.terminal.sessions.v1.host';
const FONT_KEY = 'herdr.terminal.font-sizes.v1.host';
function restore(resume: string | null, fonts: string | null) {
  multiGet.mockResolvedValue([[RESUME_KEY, resume], [FONT_KEY, fonts]]);
}
beforeEach(() => {
  jest.resetAllMocks();
  restore(null, null);
  multiSet.mockResolvedValue(undefined);
  setItem.mockResolvedValue(undefined);
});

test('loads resume and fonts in one batch without interpreting the native value', async () => {
  restore('opaque native value', '{}');
  await expect(loadPersistedTerminals('host')).resolves.toEqual({ resumeBlob: 'opaque native value', fontSizes: new Map() });
  expect(multiGet).toHaveBeenCalledWith([RESUME_KEY, FONT_KEY]);
  await savePersistedTerminals('host', 'opaque native value');
  expect(setItem).toHaveBeenCalledWith(RESUME_KEY, 'opaque native value');
});

test('extracts only presentation fonts from legacy terminal records', async () => {
  const legacy = JSON.stringify({ activeTerminalId: 'term', sessions: [
    { terminalId: 'term', paneId: 'old-pane', title: 'old-title', fontSize: 10 },
    { terminalId: 'large', fontSize: 100 }, { terminalId: 'bad', fontSize: 'no' }, null,
  ] });
  restore(legacy, null);
  expect(await loadPersistedTerminals('host')).toEqual({ resumeBlob: legacy, fontSizes: new Map([['term', 10], ['large', 24]]) });
  restore(legacy, '{"term":12}');
  expect((await loadPersistedTerminals('host')).fontSizes.get('term')).toBe(12);
});

test('commits presentation fonts and the opaque resume in one transaction', async () => {
  await new PersistedTerminalsWriter().saveIfChanged('live', 'host', 'native resume', new Map([['term', 11]]));
  expect(multiSet.mock.calls).toEqual([[[FONT_KEY, '{"term":11}'], [RESUME_KEY, 'native resume']]].map(entries => [entries]));
});

test('skips unchanged resume and fonts across projections and saves only changed values', async () => {
  const writer = new PersistedTerminalsWriter();
  await writer.saveIfChanged('live', 'host', 'resume', new Map([['term', 10]]));
  multiSet.mockClear();
  await expect(writer.saveIfChanged('live', 'host', 'resume', new Map([['term', 10]]))).resolves.toBe(false);
  expect(multiSet).not.toHaveBeenCalled();
  await writer.saveIfChanged('live', 'host', 'resume', new Map([['term', 11]]));
  expect(multiSet).toHaveBeenCalledWith([[FONT_KEY, '{"term":11}']]);
});

test('serializes transactions so an older resume cannot overwrite the latest', async () => {
  let finish!: () => void;
  multiSet.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const writer = new PersistedTerminalsWriter();
  const first = writer.saveIfChanged('live', 'host', 'first', new Map());
  const second = writer.saveIfChanged('live', 'host', 'second', new Map());
  await Promise.resolve(); await Promise.resolve();
  expect(multiSet).toHaveBeenCalledTimes(1);
  finish(); await Promise.all([first, second]);
  expect(multiSet.mock.calls).toEqual([
    [[[FONT_KEY, '{}'], [RESUME_KEY, 'first']]], [[[RESUME_KEY, 'second']]],
  ]);
});

test('retries the same atomic batch after a failed transaction', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation();
  multiSet.mockRejectedValueOnce(new Error('write unavailable'));
  const writer = new PersistedTerminalsWriter();
  await expect(writer.saveIfChanged('live', 'host', 'resume', new Map())).rejects.toThrow('write unavailable');
  await expect(writer.saveIfChanged('live', 'host', 'resume', new Map())).resolves.toBe(true);
  expect(multiSet.mock.calls[1]).toEqual(multiSet.mock.calls[0]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('storage-write-failed'));
  expect(String(log.mock.calls[0]?.[0])).not.toContain('resume');
  log.mockRestore();
});

test('propagates batch read failures with diagnostics', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation();
  multiGet.mockRejectedValueOnce(new Error('read unavailable'));
  await expect(loadPersistedTerminals('host')).rejects.toThrow('read unavailable');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('storage-read-failed'));
  log.mockRestore();
});

test('malformed fonts fall back without changing the opaque resume', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation();
  restore('native resume', '{invalid');
  await expect(loadPersistedTerminals('host')).resolves.toEqual({ resumeBlob: 'native resume', fontSizes: new Map() });
  expect(log).toHaveBeenCalledWith(expect.stringContaining('storage-parse-failed'));
  log.mockRestore();
});

test('diagnostics do not expose resume content on write failure', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation();
  setItem.mockRejectedValueOnce(new Error('write unavailable'));
  await expect(savePersistedTerminals('host', 'sensitive resume')).rejects.toThrow('write unavailable');
  expect(String(log.mock.calls[0]?.[0])).not.toContain('sensitive resume');
  log.mockRestore();
});
