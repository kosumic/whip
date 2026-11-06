import { onOpenAiVoiceCredentialChange } from '../src/services/openAiVoiceCredentials';
import { RealtimeVoiceConversation } from '../src/services/realtimeVoiceConversation';
import { DEFAULT_VOICE_CONVERSATION_SETTINGS as defaults } from '../src/lib/voiceConversationSettings';
import type { VoiceConversationView } from '../src/services/voiceConversation';
import type { AgentChatState } from '../src/agentChat';
import { request } from 'react-native-permissions';
import { loadVoiceCallSound } from '../src/services/voiceCallSounds';

const mockEvents = new Map<string, (event: unknown) => void>();
const mockApp = { currentState: 'active' };
const mockState = { sessionId: 'session-1' } as AgentChatState;
let mockTranscript: (state: AgentChatState | null) => void;
const mockRelease = jest.fn();
const mockUnsubscribe = jest.fn();
const mockInput = { reserve: jest.fn(() => true), releaseReservation: jest.fn() };
const mockNative = {
  playVoiceCallSound: jest.fn((_uri: string, _inCall: boolean) => Promise.resolve()),
  stopVoiceCallSound: jest.fn(() => Promise.resolve()),
  startVoiceCall: jest.fn(() => Promise.resolve()), endVoiceCall: jest.fn(() => Promise.resolve()),
  startRealtimeVoice: jest.fn(() => Promise.resolve()), stopRealtimeVoice: jest.fn(() => Promise.resolve()),
  realtimeVoiceView: jest.fn(() => Promise.resolve(JSON.stringify({ phase: 'listening', muted: false, level: 0.2, playbackLevel: 0, text: 'hello', error: null, inputTokens: 3, outputTokens: 4, estimatedUsd: 0.0123, messages: [{ id: 'reply', role: 'assistant', text: 'hello', spokenUtf16: 2, active: true }] }))),
  realtimeVoiceControl: jest.fn(() => Promise.resolve()),
  realtimeVoiceSubmitted: jest.fn((_token: string, _text: string) => Promise.resolve()),
  setVoiceCallMuted: jest.fn(() => Promise.resolve()), setVoiceCallSpeaker: jest.fn(() => Promise.resolve()),
};

jest.mock('react-native', () => ({
  Platform: { OS: 'android' }, get AppState() { return mockApp; },
  DeviceEventEmitter: { addListener: (name: string, listener: (event: unknown) => void) => { mockEvents.set(name, listener); return { remove: () => mockEvents.delete(name) }; } },
}));
jest.mock('react-native-permissions', () => ({ PERMISSIONS: { IOS: { MICROPHONE: 'mic' }, ANDROID: { RECORD_AUDIO: 'mic' } }, RESULTS: { GRANTED: 'granted' }, request: jest.fn(() => Promise.resolve('granted')) }));
jest.mock('../src/services/speechPlayback', () => ({ getSpeechPlayback: () => mockNative }));
jest.mock('../src/services/voiceCallSounds', () => ({ loadVoiceCallSound: jest.fn((sound: string) => Promise.resolve(`file:///${sound}.mp3`)) }));
jest.mock('../src/services/diagnosticFormatting', () => ({ recordDiagnostic: jest.fn() }));
jest.mock('../src/services/composerSpeechInput', () => ({ get composerSpeechInput() { return mockInput; } }));
jest.mock('../src/services/speechInputFocus', () => ({ setSpeechInputActive: jest.fn() }));
jest.mock('../src/services/chatSpeech', () => ({ suspendChatSpeechForInput: jest.fn(() => Promise.resolve()) }));
jest.mock('../src/services/openAiVoiceCredentials', () => ({ onOpenAiVoiceCredentialChange: jest.fn(() => () => {}), voiceCredentialError: (_error: unknown, fallback: string) => fallback }));
jest.mock('../src/services/voiceCallBackground', () => ({ retainVoiceCallBackground: () => mockRelease }));
jest.mock('../src/services/alerts', () => ({ suppressAgentAlertsForTab: () => mockRelease }));
jest.mock('../src/services/NativeTranscriptService', () => ({ agentTranscriptService: {
  realtimeTarget: () => ({ runtimeId: 'runtime-1', terminalId: 'terminal-1', paneId: 'pane-1', bindingToken: 'binding-1' }),
  subscribe: (_binding: string, listener: typeof mockTranscript) => { mockTranscript = listener; listener(mockState); return mockUnsubscribe; },
} }));

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test.each(['Realtime', 'Live'] as const)('global %s starts without a transcript or SSH target and retains its own native scope', async mode => {
  const changed = jest.fn();
  const call = new RealtimeVoiceConversation({ global: true, label: 'Global call' }, { ...defaults, provider: 'openai', mode, liveVoice: 'quartz' }, changed);
  await call.start();
  const [token, raw] = mockNative.startRealtimeVoice.mock.calls[0] as unknown as [string, string];
  expect(JSON.parse(raw)).toEqual(expect.objectContaining({ global: true, globalShizukuAccess: false, ...(mode === 'Live' ? { live: true, model: 'gpt-live-1', voice: 'quartz' } : { model: defaults.realtimeModel }) }));
  expect(JSON.parse(raw).target).toBeUndefined();
  expect(JSON.parse(raw).terminalTarget).toBeUndefined();
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'listening', transcript: null }));
  call.submitted('List my saved hosts');
  await flush();
  expect(mockNative.realtimeVoiceSubmitted).toHaveBeenCalledWith(token, 'List my saved hosts');
  await call.close();
});

test('an Android global call passes its explicitly enabled Shizuku access to native startup', async () => {
  const call = new RealtimeVoiceConversation({ global: true, label: 'Global call' }, { ...defaults, provider: 'openai', globalShizukuAccess: true }, jest.fn());
  await call.start();
  const [, raw] = mockNative.startRealtimeVoice.mock.calls[0] as unknown as [string, string];
  expect(JSON.parse(raw).globalShizukuAccess).toBe(true);
  await call.close();
});

test('starts a terminal call without an agent binding and shares typed input as context', async () => {
  const changed = jest.fn();
  const terminal = { runtimeId: 'runtime-1', runtimeIncarnation: 4, connectionGeneration: 9, terminalId: 'shell-1' };
  const call = new RealtimeVoiceConversation({ hostId: 'host', paneId: 'shell-1', tabId: 'shell-1', label: 'Shell', terminal }, { ...defaults, provider: 'openai' }, changed);
  await call.start();
  const [token, raw] = mockNative.startRealtimeVoice.mock.calls[0] as unknown as [string, string];
  const config = JSON.parse(raw);
  expect(config.terminalTarget).toEqual(terminal);
  expect(config.target).toBeUndefined();
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'listening', transcript: null }));
  call.submitted('Already typed into the selected terminal');
  await flush();
  expect(mockNative.realtimeVoiceSubmitted).toHaveBeenCalledWith(token, 'Already typed into the selected terminal');
  await call.close();
});
function setup() {
  const changed = jest.fn((_view: VoiceConversationView) => {});
  const call = new RealtimeVoiceConversation({ hostId: 'host', paneId: 'pane-1', tabId: 'tab', bindingToken: 'binding-1', agent: 'codex', label: 'Codex' }, { ...defaults, provider: 'openai', realtimeVoice: 'cedar' }, changed);
  return { call, changed };
}

test('a status-read failure retains the known voice estimate and marks it incomplete', async () => {
  const { call, changed } = setup();
  await call.start();
  mockNative.realtimeVoiceView.mockRejectedValueOnce(new Error('status read failed'));
  jest.advanceTimersByTime(100);
  await flush();
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({
    phase: 'error', estimatedUsd: 0.0123, costIncomplete: true,
  }));
  await call.close();
});
beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); mockEvents.clear(); mockApp.currentState = 'active'; });
afterEach(() => jest.useRealTimers());

test('plays the ready piano once when native Realtime becomes ready for input', async () => {
  mockNative.realtimeVoiceView.mockResolvedValueOnce(JSON.stringify({ phase: 'starting' }));
  const { call } = setup();
  await call.start();
  expect(mockNative.playVoiceCallSound).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(300);
  expect(mockNative.playVoiceCallSound.mock.calls).toEqual([['file:///ready.mp3', true]]);
  await call.close();
});

test('plays the closing piano once after stopping media and ending the system call', async () => {
  const { call } = setup();
  await call.start();
  let finished!: () => void;
  mockNative.playVoiceCallSound.mockImplementationOnce(() => new Promise(resolve => { finished = resolve; }));
  const closed = jest.fn();
  const closing = Promise.all([call.close(), call.close()]).then(closed);
  await flush();
  expect(mockNative.playVoiceCallSound.mock.calls).toEqual([['file:///ready.mp3', true], ['file:///closed.mp3', false]]);
  const cueOrder = mockNative.playVoiceCallSound.mock.invocationCallOrder[1];
  expect(mockNative.stopRealtimeVoice.mock.invocationCallOrder.at(-1)).toBeLessThan(cueOrder);
  expect(mockNative.endVoiceCall.mock.invocationCallOrder[0]).toBeLessThan(cueOrder);
  expect(mockNative.stopVoiceCallSound.mock.invocationCallOrder[0]).toBeLessThan(cueOrder);
  expect(closed).not.toHaveBeenCalled();
  expect(mockInput.releaseReservation).not.toHaveBeenCalled();
  finished();
  await closing;
  expect(mockInput.releaseReservation).toHaveBeenCalled();
});

test('a ready piano still loading at hangup cannot play after the closing cue', async () => {
  let loaded!: (uri: string) => void;
  jest.mocked(loadVoiceCallSound).mockImplementationOnce(() => new Promise(resolve => { loaded = resolve; }));
  const { call } = setup();
  await call.start();
  await call.close();
  loaded('file:///late-ready.mp3');
  await flush();
  expect(mockNative.playVoiceCallSound.mock.calls).toEqual([['file:///closed.mp3', false]]);
});

test('stops the ready piano when Realtime starts replying and does not replay it', async () => {
  let finished!: () => void;
  mockNative.playVoiceCallSound.mockImplementationOnce(() => new Promise(resolve => { finished = resolve; }));
  const { call } = setup();
  await call.start();
  mockNative.realtimeVoiceView.mockResolvedValueOnce(JSON.stringify({ phase: 'speaking' }));
  await jest.advanceTimersByTimeAsync(100);
  expect(mockNative.stopVoiceCallSound).toHaveBeenCalledTimes(1);
  finished();
  await jest.advanceTimersByTimeAsync(200);
  expect(mockNative.playVoiceCallSound.mock.calls).toEqual([['file:///ready.mp3', true]]);
  await call.close();
});

test('an audio interruption suppresses the closing piano', async () => {
  const { call } = setup();
  await call.start();
  const token = (mockNative.startVoiceCall.mock.calls[0] as unknown as [string])[0];
  mockEvents.get('WhipVoiceCall')?.({ token, type: 'audioInactive' });
  await flush();
  await call.close();
  expect(mockNative.playVoiceCallSound.mock.calls).toEqual([['file:///ready.mp3', true]]);
  expect(mockNative.stopVoiceCallSound).toHaveBeenCalled();
});

test('cue failures do not interrupt Realtime or prevent releasing the call', async () => {
  mockNative.playVoiceCallSound.mockRejectedValueOnce(new Error('Audio unavailable'));
  const { call, changed } = setup();
  await call.start();
  await flush();
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'listening', error: null }));
  expect(mockNative.stopRealtimeVoice).not.toHaveBeenCalled();
  mockNative.playVoiceCallSound.mockRejectedValueOnce(new Error('Audio unavailable'));
  await call.close();
  expect(mockInput.releaseReservation).toHaveBeenCalled();
});

test('shares typed composer submissions with the active voice session and stops sharing after close', async () => {
  const { call } = setup();
  await call.start();
  const token = (mockNative.startRealtimeVoice.mock.calls[0] as unknown as [string])[0];
  call.submitted('Please also check 日本語 captions 👋');
  await flush();
  expect(mockNative.realtimeVoiceSubmitted).toHaveBeenCalledWith(token, 'Please also check 日本語 captions 👋');
  expect(mockNative.realtimeVoiceSubmitted).toHaveBeenCalledTimes(1);
  call.submitted('   ');
  await call.close();
  call.submitted('After hangup');
  expect(mockNative.realtimeVoiceSubmitted).toHaveBeenCalledTimes(1);
});

test('reports context sharing failure without retrying a composer submission', async () => {
  mockNative.realtimeVoiceSubmitted.mockRejectedValueOnce(new Error('native error'));
  const { call, changed } = setup();
  await call.start();
  call.submitted('Already sent to the coding agent');
  await flush();
  expect(mockNative.realtimeVoiceSubmitted).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'error', error: 'The typed message could not be shared with voice. Start a new call.' }));
  await call.close();
});

test('holds typed context during native startup and flushes it in order', async () => {
  let ready!: () => void;
  mockNative.startRealtimeVoice.mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
  const { call } = setup();
  const starting = call.start();
  call.submitted('First typed message');
  await flush();
  call.submitted('Second typed message');
  expect(mockNative.realtimeVoiceSubmitted).not.toHaveBeenCalled();
  ready();
  await starting;
  expect(mockNative.realtimeVoiceSubmitted.mock.calls.map(([, text]) => text)).toEqual(['First typed message', 'Second typed message']);
  await call.close();
});

test('starts native Realtime with a pinned agent, selected voice, automatic language and server VAD', async () => {
  const { call, changed } = setup();
  call.setVadSensitivity(0.99);
  await call.start();
  expect(mockNative.startRealtimeVoice).toHaveBeenCalledTimes(1);
  const [token, config] = jest.mocked(mockNative.startRealtimeVoice).mock.calls[0] as unknown as [string, string];
  expect(JSON.parse(config)).toEqual({
    clientElapsedMs: expect.any(Number),
    clientStartup: {
      transitionMs: expect.any(Number),
      permissionMs: expect.any(Number),
      speechSuspendMs: expect.any(Number),
      callServiceMs: expect.any(Number),
    },
    target: { runtimeId: 'runtime-1', terminalId: 'terminal-1', paneId: 'pane-1', bindingToken: 'binding-1' },
    model: defaults.realtimeModel,
    voice: 'cedar',
    vad: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
  });
  expect(mockNative.startRealtimeVoice.mock.calls[0]).toHaveLength(2);
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'openai', text: 'hello', inputTokens: 3, outputTokens: 4, estimatedUsd: 0.0123 }));
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ messages: [{ id: 'reply', role: 'assistant', text: 'hello', spokenUtf16: 2, active: true }] }));
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
  expect(mockNative.playVoiceCallSound).not.toHaveBeenCalled();
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


test('credential deletion while microphone authorization is pending permanently cancels that start', async () => {
  let authorize!: () => void;
  jest.mocked(request).mockImplementationOnce(() => new Promise(resolve => { authorize = () => resolve('granted'); }));
  const { call } = setup();
  const starting = call.start();
  await flush();
  const revoke = jest.mocked(onOpenAiVoiceCredentialChange).mock.calls.at(-1)![0];
  revoke();
  authorize();
  await starting; await call.close();
  expect(mockNative.startVoiceCall).not.toHaveBeenCalled();
  expect(mockNative.startRealtimeVoice).not.toHaveBeenCalled();
});

 test('uses dedicated Realtime call setup when available without warming local speech', async () => {
  const native = mockNative as typeof mockNative & { startRealtimeVoiceCall?: jest.Mock };
  native.startRealtimeVoiceCall = jest.fn(() => Promise.resolve());
  const { call } = setup();
  try {
    await call.start();
    expect(native.startRealtimeVoiceCall).toHaveBeenCalledTimes(1);
    expect(mockNative.startVoiceCall).not.toHaveBeenCalled();
  } finally { await call.close(); delete native.startRealtimeVoiceCall; }
});

test('Live starts the independent native protocol with its selected voice and agent target', async () => {
  const changed = jest.fn();
  const call = new RealtimeVoiceConversation({ hostId: 'host', paneId: 'pane-1', tabId: 'tab', bindingToken: 'binding-1', agent: 'codex', label: 'Codex' }, { ...defaults, provider: 'openai', mode: 'Live', liveVoice: 'quartz', realtimeVoice: 'cedar' }, changed);
  await call.start();
  const [, raw] = mockNative.startRealtimeVoice.mock.calls[0] as unknown as [string, string];
  const config = JSON.parse(raw);
  expect(config).toMatchObject({ live: true, model: 'gpt-live-1', voice: 'quartz', target: { paneId: 'pane-1', bindingToken: 'binding-1' } });
  expect(config.vad).toBeUndefined();
  call.submitted('Already submitted through the composer');
  await flush();
  expect(mockNative.realtimeVoiceSubmitted).toHaveBeenCalledWith(expect.any(String), 'Already submitted through the composer');
  await call.close();
});
