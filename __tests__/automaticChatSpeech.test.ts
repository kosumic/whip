import { listenToAllTranscripts, setAutomaticChatSpeechEnabled } from '../src/services/automaticChatSpeech';
import { setSpeechInputActive } from '../src/services/speechInputFocus';
import { isChatSpeechTarget } from '../src/services/chatSpeechFocus';

const mockNative = { automaticSpeechControl: jest.fn(async (_action: string, _value: boolean) => {}) };
let mockControl: { pause: () => Promise<void>; resume: () => void };
let mockManual = false;
const mockEvents = new Map<string, Set<(event: unknown) => void>>();
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  DeviceEventEmitter: { addListener: (name: string, listener: (event: unknown) => void) => {
    const listeners = mockEvents.get(name) ?? new Set();
    listeners.add(listener); mockEvents.set(name, listeners);
    return { remove: () => listeners.delete(listener) };
  } },
}));
jest.mock('../src/services/speechPlayback', () => ({ getSpeechPlayback: () => mockNative }));
jest.mock('../src/services/chatSpeech', () => ({
  CHAT_SPEECH_STOPPED: 'WhipChatSpeechStopped',
  isChatResponsePlaying: () => mockManual,
  registerAutomaticSpeech: (control: typeof mockControl) => { mockControl = control; return jest.fn(); },
}));

function emit(name: string, event: unknown) { for (const listener of mockEvents.get(name) ?? []) listener(event); }
const flush = async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); };
let stop: () => void;
const onError = jest.fn();
beforeEach(() => {
  jest.clearAllMocks(); mockManual = false; mockEvents.clear();
  setSpeechInputActive(false);
  stop = listenToAllTranscripts(onError);
});
afterEach(() => { stop(); setSpeechInputActive(false); });

test('the shared setting enables the native reader and explicitly disables it', async () => {
  expect(mockNative.automaticSpeechControl).toHaveBeenCalledWith('enable', true);
  await setAutomaticChatSpeechEnabled(false);
  expect(mockNative.automaticSpeechControl).toHaveBeenLastCalledWith('enable', false);
});

test('manual reading and dictation pause native audio before resuming fresh updates', async () => {
  await mockControl.pause();
  expect(mockNative.automaticSpeechControl).toHaveBeenLastCalledWith('pause', true);
  mockManual = true; mockControl.resume();
  expect(mockNative.automaticSpeechControl).toHaveBeenLastCalledWith('pause', true);
  mockManual = false; mockControl.resume();
  expect(mockNative.automaticSpeechControl).toHaveBeenLastCalledWith('pause', false);
  setSpeechInputActive(true);
  expect(mockNative.automaticSpeechControl).toHaveBeenLastCalledWith('pause', true);
  setSpeechInputActive(false);
  expect(mockNative.automaticSpeechControl).toHaveBeenLastCalledWith('pause', false);
});

test('native playback errors reach presentation while manual events are ignored', () => {
  emit('WhipChatSpeechStopped', { token: 'manual', error: 'manual failure' });
  expect(onError).not.toHaveBeenCalled();
  emit('WhipChatSpeechStopped', { token: 'automatic-chat-speech', error: 'Playback failed' });
  expect(onError).toHaveBeenCalledWith(new Error('Playback failed'));
});

test('native focus follows the speaking host and pane', () => {
  emit('WhipAutomaticSpeechFocus', { hostId: 'one', paneId: 'first' });
  expect(isChatSpeechTarget('one', 'first')).toBe(true);
  emit('WhipAutomaticSpeechFocus', { hostId: 'two', paneId: 'second' });
  expect(isChatSpeechTarget('one', 'first')).toBe(false);
  expect(isChatSpeechTarget('two', 'second')).toBe(true);
  emit('WhipAutomaticSpeechFocus', {});
  expect(isChatSpeechTarget('two', 'second')).toBe(false);
});

test('detaching presentation preserves the native preference and playback lifetime', () => {
  mockNative.automaticSpeechControl.mockClear();
  stop();
  expect(mockNative.automaticSpeechControl).not.toHaveBeenCalled();
  expect([...mockEvents.values()].every(listeners => listeners.size === 0)).toBe(true);
  stop = () => {};
});

test('control failures are reported', async () => {
  const error = new Error('Native speech unavailable');
  mockNative.automaticSpeechControl.mockRejectedValueOnce(error);
  setSpeechInputActive(true);
  await flush();
  expect(onError).toHaveBeenCalledWith(error);
});
