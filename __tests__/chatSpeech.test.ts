import type { AgentChatState } from '../src/agentChat';
import { listenToChat, type ChatSpeechTarget } from '../src/services/chatSpeech';
import { isChatSpeechActive } from '../src/services/chatSpeechFocus';

const mockNative = {
  startChatSpeech: jest.fn(async (_token: string, _label: string) => {}),
  speakChat: jest.fn(async (_token: string, _text: string) => {}),
  stopChatSpeech: jest.fn(async (_token: string) => {}),
};
const mockListeners = new Map<string, (state: AgentChatState | null, baseline?: boolean) => void>();
const mockQueues: { update: jest.Mock; next: jest.Mock; dispose: jest.Mock }[] = [];
const mockEvents = new Set<(event: { token: string; error?: string }) => void>();
jest.mock('react-native', () => ({
  NativeModules: { get HerdrBackground() { return mockNative; } },
  DeviceEventEmitter: {
    addListener: (_name: string, callback: (event: { token: string; error?: string }) => void) => {
      mockEvents.add(callback);
      return { remove: () => mockEvents.delete(callback) };
    },
  },
}));
jest.mock('expo-speech', () => ({ stop: jest.fn(async () => {}) }));
jest.mock('react-native-whip-ssh', () => ({
  NativeChatSpeechQueue: jest.fn().mockImplementation(() => {
    const queue = { update: jest.fn(), next: jest.fn(), dispose: jest.fn() };
    mockQueues.push(queue);
    return queue;
  }),
}));
jest.mock('../src/services/NativeTranscriptService', () => ({
  agentTranscriptService: {
    subscribe: (binding: string, listener: (state: AgentChatState | null, baseline?: boolean) => void) => {
      mockListeners.set(binding, listener);
      return () => mockListeners.delete(binding);
    },
  },
}));
jest.mock('../src/services/backgroundOperations', () => ({
  reportBackgroundFailure: (promise: Promise<unknown>) => { void promise.catch(jest.fn()); },
}));

const target: ChatSpeechTarget = { agent: 'codex', bindingToken: 'one', hostId: 'host', paneId: 'pane', label: 'Codex' };
const state: AgentChatState = { sessionId: 'session', status: 'live', transcript: { sessionId: 'session', messages: [], turns: [] } };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let stop: (() => void) | undefined;
beforeEach(() => {
  jest.clearAllMocks();
  mockQueues.length = 0;
});
afterEach(() => { stop?.(); });

test('switching focus cancels old playback and cannot drain its remaining queue', async () => {
  let finishSpeech: () => void = () => {};
  mockNative.speakChat.mockImplementationOnce(() => new Promise(resolve => { finishSpeech = resolve; }));
  stop = listenToChat(target, jest.fn(), jest.fn());
  await flush();
  mockQueues[0].next.mockReturnValueOnce('First').mockReturnValueOnce('Must not read');
  mockListeners.get('one')!(state);
  await flush();
  expect(mockNative.speakChat).toHaveBeenCalledTimes(1);
  const oldToken = mockNative.startChatSpeech.mock.calls[0][0];
  stop = listenToChat({ ...target, bindingToken: 'two', paneId: 'other' }, jest.fn(), jest.fn());
  await flush();
  expect(mockListeners.has('one')).toBe(false);
  expect(mockQueues[0].dispose).toHaveBeenCalledTimes(1);
  expect(mockNative.stopChatSpeech).toHaveBeenCalledWith(oldToken);
  finishSpeech();
  await flush();
  expect(mockNative.speakChat).toHaveBeenCalledTimes(1);
});

test('notification stop removes the listener and ignores a delayed stop from an old owner', async () => {
  const onStopped = jest.fn();
  stop = listenToChat(target, onStopped, jest.fn());
  await flush();
  const token = mockNative.startChatSpeech.mock.calls[0][0];
  for (const listener of mockEvents) listener({ token: 'obsolete' });
  expect(isChatSpeechActive()).toBe(true);
  for (const listener of mockEvents) listener({ token });
  expect(isChatSpeechActive()).toBe(false);
  expect(mockListeners.size).toBe(0);
  expect(onStopped).toHaveBeenCalledTimes(1);
});

test('leaving chat while the speech engine starts never begins a queued utterance', async () => {
  let initialized: () => void = () => {};
  mockNative.startChatSpeech.mockImplementationOnce(() => new Promise(resolve => { initialized = resolve; }));
  stop = listenToChat(target, jest.fn(), jest.fn());
  await flush();
  mockQueues[0].next.mockReturnValueOnce('Late reply');
  mockListeners.get('one')!(state);
  stop();
  initialized();
  await flush();
  expect(mockNative.speakChat).not.toHaveBeenCalled();
});

test('a full transcript reset establishes a fresh baseline before accepting updates', async () => {
  stop = listenToChat(target, jest.fn(), jest.fn());
  await flush();
  mockListeners.get('one')!(state, true);
  expect(mockQueues[0].update.mock.calls).toEqual([
    ['codex', false, []], ['codex', true, []],
  ]);
});

test('native speech failure clears focus and reports the error', async () => {
  const onError = jest.fn();
  const onStopped = jest.fn();
  stop = listenToChat(target, onStopped, onError);
  await flush();
  const token = mockNative.startChatSpeech.mock.calls[0][0];
  for (const listener of mockEvents) listener({ token, error: 'Install a voice' });
  expect(isChatSpeechActive()).toBe(false);
  expect(onError).toHaveBeenCalledWith(new Error('Install a voice'));
  expect(onStopped).toHaveBeenCalledTimes(1);
});
