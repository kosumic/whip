import { RealtimeVoiceConversation } from '../src/services/realtimeVoiceConversation';
import { DEFAULT_VOICE_CONVERSATION_SETTINGS as defaults } from '../src/lib/voiceConversationSettings';
import type { VoiceConversationView } from '../src/services/voiceConversation';
import type { AgentChatState } from '../src/agentChat';
import { request } from 'react-native-permissions';

const mockEvents = new Map<string, (event: unknown) => void>();
const mockApp = { currentState: 'active' };
const mockState = { sessionId: 'session-1' } as AgentChatState;
let mockTranscript: (state: AgentChatState | null) => void;
const mockRelease = jest.fn();
const mockUnsubscribe = jest.fn();
const mockInput = { reserve: jest.fn(() => true), releaseReservation: jest.fn() };
const mockNative = {
  startVoiceCall: jest.fn(() => Promise.resolve()), endVoiceCall: jest.fn(() => Promise.resolve()),
  startRealtimeVoice: jest.fn(() => Promise.resolve()), stopRealtimeVoice: jest.fn(() => Promise.resolve()),
  realtimeVoiceView: jest.fn(() => Promise.resolve(JSON.stringify({ phase: 'listening', muted: false, level: 0.2, playbackLevel: 0, text: 'hello', error: null, inputTokens: 3, outputTokens: 4 }))),
  realtimeVoiceControl: jest.fn(() => Promise.resolve()),
  setVoiceCallMuted: jest.fn(() => Promise.resolve()), setVoiceCallSpeaker: jest.fn(() => Promise.resolve()),
};

jest.mock('react-native', () => ({
  Platform: { OS: 'android' }, get AppState() { return mockApp; },
  DeviceEventEmitter: { addListener: (name: string, listener: (event: unknown) => void) => { mockEvents.set(name, listener); return { remove: () => mockEvents.delete(name) }; } },
}));
jest.mock('react-native-permissions', () => ({ PERMISSIONS: { IOS: { MICROPHONE: 'mic' }, ANDROID: { RECORD_AUDIO: 'mic' } }, RESULTS: { GRANTED: 'granted' }, request: jest.fn(() => Promise.resolve('granted')) }));
jest.mock('../src/services/speechPlayback', () => ({ getSpeechPlayback: () => mockNative }));
jest.mock('../src/services/composerSpeechInput', () => ({ get composerSpeechInput() { return mockInput; } }));
jest.mock('../src/services/speechInputFocus', () => ({ setSpeechInputActive: jest.fn() }));
jest.mock('../src/services/chatSpeech', () => ({ suspendChatSpeechForInput: jest.fn(() => Promise.resolve()) }));
jest.mock('../src/services/openAiVoiceCredentials', () => ({ readOpenAiVoiceKey: jest.fn(() => Promise.resolve('sk-private-test')) }));
jest.mock('../src/services/voiceCallBackground', () => ({ retainVoiceCallBackground: () => mockRelease }));
jest.mock('../src/services/alerts', () => ({ suppressAgentAlertsForTab: () => mockRelease }));
jest.mock('../src/services/NativeTranscriptService', () => ({ agentTranscriptService: {
  realtimeTarget: () => ({ runtimeId: 'runtime-1', terminalId: 'terminal-1', paneId: 'pane-1', bindingToken: 'binding-1' }),
  subscribe: (_binding: string, listener: typeof mockTranscript) => { mockTranscript = listener; listener(mockState); return mockUnsubscribe; },
} }));

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup() {
  const changed = jest.fn((_view: VoiceConversationView) => {});
  const call = new RealtimeVoiceConversation({ hostId: 'host', paneId: 'pane-1', tabId: 'tab', bindingToken: 'binding-1', agent: 'codex', label: 'Codex' }, { ...defaults, provider: 'openai', realtimeVoice: 'cedar' }, changed);
  return { call, changed };
}
beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); mockEvents.clear(); mockApp.currentState = 'active'; });
afterEach(() => jest.useRealTimers());

test('starts native Realtime with a pinned agent, selected voice, automatic language and server VAD', async () => {
  const { call, changed } = setup();
  call.setVadSensitivity(0.99);
  await call.start();
  expect(mockNative.startRealtimeVoice).toHaveBeenCalledTimes(1);
  const [token, config, key] = jest.mocked(mockNative.startRealtimeVoice).mock.calls[0] as unknown as [string, string, string];
  expect(JSON.parse(config)).toEqual({ target: { runtimeId: 'runtime-1', terminalId: 'terminal-1', paneId: 'pane-1', bindingToken: 'binding-1' }, voice: 'cedar', vad: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 } });
  expect(key).toBe('sk-private-test');
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'openai', text: 'hello', inputTokens: 3, outputTokens: 4 }));
  call.toggleMuted();
  await call.skip();
  expect(mockNative.setVoiceCallMuted).toHaveBeenCalledWith(token, true);
  expect(mockNative.realtimeVoiceControl).toHaveBeenCalledWith(token, 1);
  await call.close();
  expect(mockNative.endVoiceCall).toHaveBeenCalledWith(token);
  expect(mockInput.releaseReservation).toHaveBeenCalledWith(token);
  expect(mockUnsubscribe).toHaveBeenCalled();
});

test('background presentation retains native ownership and system hangup closes the call', async () => {
  const { call, changed } = setup();
  await call.start();
  mockApp.currentState = 'background';
  await jest.advanceTimersByTimeAsync(200);
  expect(mockNative.stopRealtimeVoice).not.toHaveBeenCalled();
  const token = (mockNative.startVoiceCall.mock.calls[0] as unknown as [string])[0];
  mockEvents.get('WhipVoiceCall')?.({ token, type: 'ended' });
  await flush();
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'closed' }));
  expect(mockRelease).toHaveBeenCalled();
  await call.close();
});

test('backgrounding during microphone authorization cannot start a new call', async () => {
  let authorize!: () => void;
  jest.mocked(request).mockImplementationOnce(() => new Promise(resolve => { authorize = () => resolve('granted'); }));
  const { call, changed } = setup();
  const starting = call.start();
  await flush();
  mockApp.currentState = 'background';
  authorize();
  await starting; await call.close();
  expect(mockNative.startVoiceCall).not.toHaveBeenCalled();
  expect(mockNative.startRealtimeVoice).not.toHaveBeenCalled();
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'error' }));
  expect(mockInput.releaseReservation).toHaveBeenCalled();
});

test('disconnect and binding replacement stop media and reject late status callbacks', async () => {
  const { call, changed } = setup();
  await call.start();
  mockTranscript(null);
  await flush();
  const count = changed.mock.calls.length;
  call.setTranscriptBinding('replacement');
  await jest.advanceTimersByTimeAsync(200);
  expect(changed).toHaveBeenCalledTimes(count);
  expect(mockNative.stopRealtimeVoice).toHaveBeenCalled();
  await call.close();
});

test('temporary presentation binding loss retains the original native call', async () => {
  const { call } = setup();
  await call.start();
  call.setTranscriptBinding();
  await jest.advanceTimersByTimeAsync(200);
  expect(mockNative.stopRealtimeVoice).not.toHaveBeenCalled();
  expect(mockNative.startRealtimeVoice).toHaveBeenCalledTimes(1);
  await call.close();
});

test('hangup drains a pending native startup and stops its late completion', async () => {
  let ready!: () => void;
  mockNative.startRealtimeVoice.mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
  const { call, changed } = setup();
  const starting = call.start();
  await flush();
  const closing = call.close();
  await flush();
  expect(mockNative.stopRealtimeVoice).toHaveBeenCalled();
  ready();
  await starting; await closing;
  expect(mockNative.realtimeVoiceView).not.toHaveBeenCalled();
  expect(JSON.stringify(changed.mock.calls)).not.toContain('sk-private-test');
  expect(mockNative.endVoiceCall).toHaveBeenCalledTimes(1);
});

test('native errors never surface method arguments or credentials', async () => {
  mockNative.startRealtimeVoice.mockRejectedValueOnce(new Error('startRealtimeVoice sk-private-test raw response'));
  const { call, changed } = setup();
  await call.start(); await call.close();
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'error' }));
  expect(JSON.stringify(changed.mock.calls)).not.toContain('sk-private-test');
});

test('synchronous native startup failures also redact API credentials', async () => {
  mockNative.startRealtimeVoice.mockImplementationOnce(() => { throw new Error('bridge sk-private-test'); });
  const { call, changed } = setup();
  await call.start(); await call.close();
  expect(JSON.stringify(changed.mock.calls)).not.toContain('sk-private-test');
});
