import AsyncStorage from '@react-native-async-storage/async-storage';
import { TerminalComposerStore } from '../src/lib/terminalComposerStore';
import { terminalRendererKey } from '../src/lib/terminalRenderer';
import { COMPOSER_SAVE_DEBOUNCE_MS, TerminalComposerPersistence } from '../src/services/terminalComposerPersistence';
import { recordStorageDiagnostic } from '../src/services/storageDiagnostics';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
}));
jest.mock('../src/services/storageDiagnostics', () => ({
  recordStorageDiagnostic: jest.fn(), storageErrorDetails: () => ({}), storageParseErrorDetails: () => ({}),
}));
jest.mock('../src/services/backgroundOperations', () => ({
  reportBackgroundFailure: (promise: Promise<unknown>) => { void promise.catch(jest.fn()); },
}));

const STORAGE_KEY = 'whip.terminal.composers.v1.host';
const OTHER_STORAGE_KEY = 'whip.terminal.composers.v1.other-host';
const key = terminalRendererKey('runtime', 'term');
const otherKey = terminalRendererKey('runtime', 'other');
const saved = { text: 'saved draft', composeOpen: true, composeExpanded: true };
const defaults = { text: '', composeOpen: false, composeExpanded: false };
let disk: Map<string, string>;
let instances: TerminalComposerPersistence[];
function setup() {
  const store = new TerminalComposerStore();
  const persistence = new TerminalComposerPersistence(store);
  instances.push(persistence);
  return { store, persistence };
}

beforeEach(() => {
  jest.useFakeTimers();
  instances = [];
  disk = new Map();
  jest.mocked(AsyncStorage.getItem).mockReset().mockImplementation(async id => disk.get(id) ?? null);
  jest.mocked(AsyncStorage.setItem).mockReset().mockImplementation(async (id, value) => { disk.set(id, value); });
  jest.mocked(AsyncStorage.removeItem).mockReset().mockImplementation(async id => { disk.delete(id); });
  jest.mocked(recordStorageDiagnostic).mockClear();
});
afterEach(async () => {
  for (const persistence of instances) {
    await Promise.allSettled([persistence.flush()]);
    persistence.dispose();
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('debounces text edits and restores drafts and toggles across restarts with a new runtime ID', async () => {
  const { store, persistence } = setup();
  await persistence.bind('runtime', 'host');
  expect(store.snapshot(key)).toMatchObject(defaults);
  store.setText(key, 'first edit');
  await jest.advanceTimersByTimeAsync(COMPOSER_SAVE_DEBOUNCE_MS - 1);
  store.setText(key, saved.text);
  store.setToggles(key, true, true);
  await jest.advanceTimersByTimeAsync(COMPOSER_SAVE_DEBOUNCE_MS - 1);
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
  expect(JSON.parse(disk.get(STORAGE_KEY)!)).toEqual({ term: saved });

  const restarted = setup();
  await restarted.persistence.bind('new-runtime', 'host');
  expect(restarted.store.snapshot(terminalRendererKey('new-runtime', 'term'))).toMatchObject(saved);
  expect(restarted.store.snapshot(terminalRendererKey('new-runtime', 'new-pane'))).toMatchObject(defaults);
});

test('identical terminal IDs remain independent across stable host identities', async () => {
  disk.set(STORAGE_KEY, JSON.stringify({ term: saved }));
  disk.set(OTHER_STORAGE_KEY, JSON.stringify({ term: { ...defaults, text: 'other host' } }));
  const { store, persistence } = setup();
  await Promise.all([persistence.bind('runtime', 'host'), persistence.bind('another-runtime', 'other-host')]);
  expect(store.snapshot(key)).toMatchObject(saved);
  expect(store.snapshot(terminalRendererKey('another-runtime', 'term'))).toMatchObject({ ...defaults, text: 'other host' });
  store.setText(key, 'updated');
  await persistence.flush();
  expect(JSON.parse(disk.get(OTHER_STORAGE_KEY)!)).toEqual({ term: { ...defaults, text: 'other host' } });
});

test('persists only text and toggles while attachments, queues, and pending images remain transient', async () => {
  const { store, persistence } = setup();
  await persistence.bind('runtime', 'host');
  store.setText(key, saved.text);
  store.setToggles(key, true, true);
  store.addAttachment(key, { id: 1, remotePath: '/private/image', previewUri: 'file:///image', dispose: jest.fn() });
  store.enqueue(key, 'queued text', []);
  store.beginImagePaste(key, jest.fn());
  await persistence.flush();
  expect(JSON.parse(disk.get(STORAGE_KEY)!)).toEqual({ term: saved });
  const restarted = setup();
  await restarted.persistence.bind('runtime', 'host');
  expect(restarted.store.snapshot(key)).toMatchObject({ ...saved, attachments: [], queue: [], imagePastes: new Map() });
});

test('late hydration preserves newer text edits, including edits cleared back to empty', async () => {
  let finish!: (value: string) => void;
  jest.mocked(AsyncStorage.getItem).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { store, persistence } = setup();
  const loading = persistence.bind('runtime', 'host');
  store.setText(key, 'new edit');
  store.setText(key, '');
  finish(JSON.stringify({ term: saved }));
  await loading;
  expect(store.snapshot(key)).toMatchObject({ ...saved, text: '' });
  await persistence.flush();
  expect(JSON.parse(disk.get(STORAGE_KEY)!)).toEqual({ term: { ...saved, text: '' } });
});

test('late hydration merges saved text with newer toggles', async () => {
  let finish!: (value: string) => void;
  jest.mocked(AsyncStorage.getItem).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { store, persistence } = setup();
  const loading = persistence.bind('runtime', 'host');
  store.setToggles(key, true);
  finish(JSON.stringify({ term: saved }));
  await loading;
  expect(store.snapshot(key)).toMatchObject({ ...saved, composeExpanded: false });
});

test('serializes writes and skips obsolete queued values so the newest edit wins', async () => {
  const { store, persistence } = setup();
  await persistence.bind('runtime', 'host');
  let finish!: () => void;
  jest.mocked(AsyncStorage.setItem).mockImplementationOnce((id, value) => new Promise(resolve => {
    finish = () => { disk.set(id, value); resolve(); };
  }));
  store.setText(key, 'first');
  await jest.advanceTimersByTimeAsync(COMPOSER_SAVE_DEBOUNCE_MS);
  store.setText(key, 'second');
  await jest.advanceTimersByTimeAsync(COMPOSER_SAVE_DEBOUNCE_MS);
  store.setText(key, 'newest');
  expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
  finish();
  await persistence.flush();
  expect(AsyncStorage.setItem).toHaveBeenCalledTimes(2);
  expect(JSON.parse(disk.get(STORAGE_KEY)!)).toEqual({ term: { ...defaults, text: 'newest' } });
});

test('permanent removal wins over an in-flight write and preserves sibling panes', async () => {
  const { store, persistence } = setup();
  await persistence.bind('runtime', 'host');
  store.setText(otherKey, 'sibling');
  store.setToggles(key, true, true);
  let finish!: () => void;
  jest.mocked(AsyncStorage.setItem).mockImplementationOnce((id, value) => new Promise(resolve => {
    finish = () => { disk.set(id, value); resolve(); };
  }));
  await jest.advanceTimersByTimeAsync(COMPOSER_SAVE_DEBOUNCE_MS);
  persistence.retain('runtime', new Set(['other']));
  finish();
  await persistence.flush();
  expect(store.snapshot(key)).toMatchObject(defaults);
  expect(JSON.parse(disk.get(STORAGE_KEY)!)).toEqual({ other: { ...defaults, text: 'sibling' } });
  persistence.retain('runtime', new Set());
  await persistence.flush();
  expect(disk.has(STORAGE_KEY)).toBe(false);
});

test('removal before hydration cannot resurrect a deleted pane from disk', async () => {
  let finish!: (value: string) => void;
  jest.mocked(AsyncStorage.getItem).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { store, persistence } = setup();
  const loading = persistence.bind('runtime', 'host');
  persistence.retain('runtime', new Set());
  finish(JSON.stringify({ term: saved }));
  await loading;
  await persistence.flush();
  expect(store.snapshot(key)).toMatchObject(defaults);
  expect(disk.has(STORAGE_KEY)).toBe(false);
});

test('temporary target loss and host detachment keep saved state for reconnecting', async () => {
  const { store, persistence } = setup();
  await persistence.bind('runtime', 'host');
  store.setText(key, saved.text);
  store.setToggles(key, true, true);
  store.retain(new Set());
  persistence.detach('runtime');
  store.removeSession('runtime');
  await persistence.flush();
  expect(JSON.parse(disk.get(STORAGE_KEY)!)).toEqual({ term: saved });
  await persistence.bind('replacement-runtime', 'host');
  expect(store.snapshot(terminalRendererKey('replacement-runtime', 'term'))).toMatchObject(saved);
});

test.each(['invalid json', '[]', '{"term":{"text":false}}'])('malformed records default safely: %s', async value => {
  disk.set(STORAGE_KEY, value);
  const { store, persistence } = setup();
  await persistence.bind('runtime', 'host');
  expect(store.snapshot(key)).toMatchObject(defaults);
});

test('failed reads do not overwrite saved data with defaults', async () => {
  disk.set(STORAGE_KEY, JSON.stringify({ term: saved }));
  jest.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('unavailable'));
  const { store, persistence } = setup();
  await expect(persistence.bind('runtime', 'host')).rejects.toThrow('unavailable');
  store.setText(key, 'local edit');
  await jest.advanceTimersByTimeAsync(COMPOSER_SAVE_DEBOUNCE_MS);
  expect(JSON.parse(disk.get(STORAGE_KEY)!)).toEqual({ term: saved });
  expect(recordStorageDiagnostic).toHaveBeenCalledWith('error', 'storage-read-failed', expect.any(Object));
});

test('a later edit can persist after a failed write', async () => {
  const { store, persistence } = setup();
  await persistence.bind('runtime', 'host');
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('unavailable'));
  store.setText(key, 'first');
  await expect(persistence.flush()).rejects.toThrow('unavailable');
  store.setText(key, 'retry');
  await persistence.flush();
  expect(JSON.parse(disk.get(STORAGE_KEY)!)).toEqual({ term: { ...defaults, text: 'retry' } });
});
