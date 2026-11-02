import { listenToAllTranscripts } from '../src/services/automaticChatSpeech';
import { setSpeechInputActive } from '../src/services/speechInputFocus';
import type { ObservedAgentTranscript } from '../src/services/NativeTranscriptService';

const mockNative = {
  startChatSpeech: jest.fn(async () => {}),
  speakChat: jest.fn<Promise<void>, [string, string]>(async () => {}),
  stopChatSpeech: jest.fn(async () => {}),
};
const mockPending: { key: string; text: string }[] = [];
const mockQueue = {
  update: jest.fn(), next: jest.fn(() => mockPending.shift()),
  remove: jest.fn(), reset: jest.fn(() => { mockPending.length = 0; }), dispose: jest.fn(),
};
let mockObserve: (event: ObservedAgentTranscript) => void;
const mockUnsubscribe = jest.fn();
let mockControl: { pause: () => Promise<void>; resume: () => void };
let mockManual = false;
const mockEvents = new Set<(event: { token: string; error?: string }) => void>();
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  DeviceEventEmitter: { addListener: (_name: string, listener: (event: { token: string; error?: string }) => void) => {
    mockEvents.add(listener);
    return { remove: () => mockEvents.delete(listener) };
  } },
}));
jest.mock('react-native-whip-ssh', () => ({ NativeAutomaticChatSpeechQueue: jest.fn(() => mockQueue) }));
jest.mock('../src/services/speechPlayback', () => ({ getSpeechPlayback: () => mockNative }));
jest.mock('../src/services/NativeTranscriptService', () => ({ agentTranscriptService: {
  observe: (listener: typeof mockObserve) => { mockObserve = listener; return mockUnsubscribe; },
} }));
jest.mock('../src/services/chatSpeech', () => ({
  CHAT_SPEECH_STOPPED: 'WhipChatSpeechStopped',
  isChatResponsePlaying: () => mockManual,
  registerAutomaticSpeech: (control: typeof mockControl) => { mockControl = control; return jest.fn(); },
}));

function event(key: string, status: 'loading' | 'live' | 'stale' = 'live', baseline = false): ObservedAgentTranscript {
  return {
    key, hostSessionId: `host-${key}`, tabName: `${key} tab`, baseline,
    binding: {
      agent: 'codex', bindingToken: key, paneId: key, terminalId: key,
      sessionId: key, transcriptKey: key, runtimeIncarnation: 1, bindingGeneration: 1,
      state: { sessionId: key, agent: 'codex', revision: 1, status, messages: [], turns: [] },
    },
    state: { sessionId: key, status, transcript: { sessionId: key, messages: [], turns: [] } },
  };
}
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
let stop: () => void;
const onError = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  mockPending.length = 0;
  mockManual = false;
  setSpeechInputActive(false);
  stop = listenToAllTranscripts(onError);
});
afterEach(() => { stop(); setSpeechInputActive(false); });

test('reads every ready transcript sequentially without any chat viewport or focus', async () => {
  mockObserve(event('debug', 'live', true));
  mockObserve(event('build', 'live', true));
  expect(mockNative.startChatSpeech).not.toHaveBeenCalled();
  let finish!: () => void;
  mockNative.speakChat.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  mockPending.push({ key: 'debug', text: 'debug tab: First or Second.' });
  mockObserve(event('debug'));
  await flush();
  mockPending.push({ key: 'build', text: 'build tab: Finished.' });
  mockObserve(event('build'));
  await flush();
  expect(mockNative.speakChat.mock.calls.map(call => call[1])).toEqual(['debug tab: First or Second.']);
  finish();
  await flush();
  expect(mockNative.speakChat.mock.calls.map(call => call[1])).toEqual(['debug tab: First or Second.', 'build tab: Finished.']);
  expect(mockNative.startChatSpeech).toHaveBeenCalledTimes(1);
  expect(mockNative.stopChatSpeech).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
});

test('loading and stale snapshots are not live speech sources; closing removes pending speech', async () => {
  const loading = event('debug', 'loading');
  mockObserve(loading);
  expect(mockQueue.update).toHaveBeenLastCalledWith('debug', 'codex', 'debug tab', false, false, []);
  mockObserve(event('debug', 'stale'));
  expect(mockQueue.update).toHaveBeenLastCalledWith('debug', 'codex', 'debug tab', false, false, []);
  mockObserve({ ...loading, state: null });
  expect(mockQueue.remove).toHaveBeenCalledWith('debug');
  await flush();
  expect(mockNative.speakChat).not.toHaveBeenCalled();
});

test('a stale transcript cancels its current utterance without silencing other ready transcripts', async () => {
  mockObserve(event('debug', 'live', true));
  mockObserve(event('build', 'live', true));
  let cancel!: (error: Error) => void;
  mockNative.speakChat.mockImplementationOnce(() => new Promise((_resolve, reject) => { cancel = reject; }));
  mockPending.push({ key: 'debug', text: 'debug tab: Current.' });
  mockObserve(event('debug'));
  await flush();
  mockPending.push({ key: 'build', text: 'build tab: New update.' });
  mockObserve(event('build'));
  mockObserve(event('debug', 'stale'));
  cancel(new Error('Cancelled'));
  await flush();
  expect(mockNative.speakChat.mock.calls.map(call => call[1])).toEqual(['debug tab: Current.', 'build tab: New update.']);
  expect(onError).not.toHaveBeenCalled();
});

test('manual reading and dictation flush automatic backlog and resume with fresh baselines', async () => {
  mockObserve(event('debug', 'live', true));
  mockPending.push({ key: 'debug', text: 'discard queued content' });
  await mockControl.pause();
  mockManual = true;
  mockObserve(event('debug'));
  expect(mockPending).toEqual([]);
  expect(mockQueue.update).toHaveBeenLastCalledWith('debug', 'codex', 'debug tab', false, false, []);
  mockControl.resume();
  mockManual = false;
  mockControl.resume();
  expect(mockQueue.update).toHaveBeenLastCalledWith('debug', 'codex', 'debug tab', true, true, []);
  setSpeechInputActive(true);
  mockObserve(event('debug'));
  expect(mockQueue.update).toHaveBeenLastCalledWith('debug', 'codex', 'debug tab', false, false, []);
  setSpeechInputActive(false);
  expect(mockQueue.update).toHaveBeenLastCalledWith('debug', 'codex', 'debug tab', true, true, []);
  await flush();
  expect(mockNative.speakChat).not.toHaveBeenCalled();
});

test('native stop silences all automatic speech until the setting starts a new listener', async () => {
  mockObserve(event('debug', 'live', true));
  let finish!: () => void;
  mockNative.speakChat.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  mockPending.push({ key: 'debug', text: 'debug tab: Current.' });
  mockObserve(event('debug'));
  await flush();
  const token = mockNative.speakChat.mock.calls[0][0];
  for (const listener of mockEvents) listener({ token });
  finish();
  await flush();
  mockObserve(event('build'));
  expect(mockQueue.update).toHaveBeenLastCalledWith('build', 'codex', 'build tab', false, false, []);
  expect(mockNative.speakChat).toHaveBeenCalledTimes(1);
});

test('disabling automatic speech unsubscribes, disposes queues, and stops its active lease', async () => {
  mockObserve(event('debug', 'live', true));
  mockPending.push({ key: 'debug', text: 'debug tab: Current.' });
  mockObserve(event('debug'));
  await flush();
  stop();
  expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  expect(mockQueue.dispose).toHaveBeenCalledTimes(1);
  expect(mockEvents.size).toBe(0);
  stop = () => {};
});
