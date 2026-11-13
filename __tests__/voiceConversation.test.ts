let mockCaptionSnapshot = 'null';
jest.mock('react-native-whip-ssh', () => ({ speechCaptionSnapshot: () => mockCaptionSnapshot }));
import { VoiceConversation, type VoiceConversationView } from '../src/services/voiceConversation';
import type { AgentChatState } from '../src/agentChat';
import type { NativeVoiceChat } from 'react-native-whip-ssh/src/voiceChat';
import type { LocalVoiceSource, VoiceSpeechEffect } from 'react-native-whip-ssh/src/voiceChat';
import { suppressAgentAlertsForTab } from '../src/services/alerts';
import { runVoiceCallBackground } from '../src/services/voiceCallBackground';
import { loadVoiceCallSound } from '../src/services/voiceCallSounds';

jest.mock('../src/services/voiceCallSounds', () => ({
  loadVoiceCallSound: jest.fn((sound: string) => Promise.resolve(`file:///${sound}.mp3`)),
}));

const mockReleaseAlerts = jest.fn();
jest.mock('../src/services/alerts', () => ({
  suppressAgentAlertsForTab: jest.fn(() => mockReleaseAlerts),
}));

const mockInputListeners = new Set<() => void>();
const mockAppListeners = new Set<(state: string) => void>();
const mockCallEvents = new Map<string, (event: { token: string; type: string; muted?: boolean; reason?: string; error?: string; level?: number }) => void>();
const mockTranscriptListeners = new Set<(state: AgentChatState | null, baseline?: boolean) => void>();
let mockInputSnapshot = { owner: null as string | null, phase: 'idle', interimText: '' };
let mockView = { phase: 'preparing', inputId: 1n, muted: false, smartTurn: false, text: '', level: 0, silenceMs: 800, progress: 0, analyze: false, audioError: null as string | null };
let mockRequest: {
  owner: string; localOnly: boolean; duringPlayback?: boolean; append: (text: string) => void;
  audioCapture: { open: () => string; close: (handle: string) => void }; onError: (error: string, message: string) => void;
} | undefined;
let mockNotify: () => void = () => {};
let mockEffects: VoiceSpeechEffect[] = [];
const mockActiveTokens = new Set<string>();
const mockCore = {
  connect: jest.fn((_source: LocalVoiceSource, notify: () => void) => { mockNotify = notify; }),
  takeEffects: jest.fn(() => { const batch = mockEffects; mockEffects = []; return batch; }),
  playbackCurrent: jest.fn((token: string) => mockActiveTokens.has(token)),
  acknowledgeSpeech: jest.fn(),
  submitText: jest.fn(),
  view: jest.fn(() => mockView),
  speechFinished: jest.fn(() => true),
  skipResponse: jest.fn(() => { mockView.phase = "listening"; mockView.inputId += 1n; }),
  prepare: jest.fn((_install: boolean) => { mockView.phase = 'listening'; return Promise.resolve(); }),
  beginPreparation: jest.fn(() => { mockView.phase = 'preparing'; }),
  useVad: jest.fn(() => { mockView.phase = 'listening'; }),
  openAudioCapture: jest.fn(() => 101n), closeAudioCapture: jest.fn(),
  audio: jest.fn(), analyze: jest.fn(() => Promise.resolve()), recognition: jest.fn(),
  ended: jest.fn(), takePrompt: jest.fn(), transcript: jest.fn(), nextSpeech: jest.fn(),
  playbackText: jest.fn(),
  playbackEnded: jest.fn(() => { mockView.phase = 'listening'; }),
  setMuted: jest.fn(), finish: jest.fn(), close: jest.fn(),
  setVadSensitivity: jest.fn(),
};
const mockSpeech = {
  playVoiceCallSound: jest.fn((_uri: string, _inCall: boolean) => Promise.resolve()),
  stopVoiceCallSound: jest.fn(() => Promise.resolve()),
  startVoiceCall: jest.fn((_token: string, _label: string) => Promise.resolve()), endVoiceCall: jest.fn(() => Promise.resolve()),
  setVoiceCallMuted: jest.fn(() => Promise.resolve()), setVoiceCallSpeaker: jest.fn(() => Promise.resolve()),
  startLocalChatSpeech: jest.fn(() => Promise.resolve()), speakChat: jest.fn((_token: string, _text: string) => Promise.resolve()),
  enqueueChatSpeech: undefined as jest.Mock<Promise<void>, [string, string]> | undefined,
  enqueueChatSpeechWithSource: undefined as jest.Mock<Promise<void>, [string, string, string]> | undefined,
  speakChatWithSource: undefined as jest.Mock<Promise<void>, [string, string, string]> | undefined,
  stopChatSpeech: jest.fn(() => Promise.resolve()),
};
const mockInput = {
  authorizeLocal: jest.fn(() => Promise.resolve()),
  supportsPlaybackMonitoring: jest.fn(() => Promise.resolve(true)),
  reserve: jest.fn(() => true), releaseReservation: jest.fn(),
  getSnapshot: () => mockInputSnapshot,
  subscribe: (listener: () => void) => { mockInputListeners.add(listener); return () => mockInputListeners.delete(listener); },
  start: jest.fn((request: NonNullable<typeof mockRequest>) => {
    mockRequest = request;
    mockInputSnapshot = { owner: request.owner, phase: 'listening', interimText: '' };
    for (const listener of mockInputListeners) listener();
    return Promise.resolve();
  }),
  stop: jest.fn(),
  cancel: jest.fn(() => {
    mockInputSnapshot = { owner: null, phase: 'idle', interimText: '' };
    for (const listener of mockInputListeners) listener();
  }),
};
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  DeviceEventEmitter: { addListener: jest.fn((name: string, listener: (event: { token: string; type: string }) => void) => {
    mockCallEvents.set(name, listener); return { remove: () => mockCallEvents.delete(name) };
  }) },
  AppState: { currentState: 'active', addEventListener: (_name: string, listener: (state: string) => void) => {
    mockAppListeners.add(listener); return { remove: () => mockAppListeners.delete(listener) };
  } },
}));
jest.mock('expo-file-system', () => ({ Paths: { cache: 'file:///cache' }, Directory: class { uri = 'file:///cache/voice-chat'; } }));
jest.mock('react-native-whip-ssh/src/voiceChat', () => ({ NativeVoiceChat: jest.fn(() => mockCore) }));
jest.mock('../src/services/diagnosticFormatting', () => ({ recordDiagnostic: jest.fn() }));
jest.mock('../src/services/speechPlayback', () => ({ getSpeechPlayback: () => mockSpeech }));
jest.mock('../src/services/chatSpeech', () => ({ suspendChatSpeechForInput: jest.fn(() => Promise.resolve()) }));
jest.mock('../src/services/composerSpeechInput', () => ({ get composerSpeechInput() { return mockInput; } }));
jest.mock('../src/services/NativeTranscriptService', () => ({ agentTranscriptService: {
  subscribe: (_binding: string, listener: (state: AgentChatState | null, baseline?: boolean) => void) => {
    mockTranscriptListeners.add(listener); return () => mockTranscriptListeners.delete(listener);
  },
} }));
const target = { agent: 'codex' as const, bindingToken: 'chat', hostId: 'host', paneId: 'pane', tabId: 'tab', label: 'Codex', localSource: { runtimeId: 'runtime', incarnation: 7n, terminalId: 'terminal', paneId: 'pane', agent: 'codex' as const, queue: {} as LocalVoiceSource['queue'], targetKey: 'destination' } };
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
let session: VoiceConversation;
let changed: jest.Mock<void, [VoiceConversationView]>;
let send: jest.Mock<boolean, [string]>;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockSpeech.enqueueChatSpeech = undefined;
  mockSpeech.enqueueChatSpeechWithSource = undefined;
  mockSpeech.speakChatWithSource = undefined;
  mockEffects = [];
  mockActiveTokens.clear();
  mockInputSnapshot = { owner: null, phase: 'idle', interimText: '' };
  mockView = { phase: 'preparing', inputId: 1n, muted: false, smartTurn: false, text: '', level: 0, silenceMs: 800, progress: 0, analyze: false, audioError: null as string | null };
  mockRequest = undefined;
  mockCore.speechFinished.mockReturnValue(true);
  mockCore.nextSpeech.mockReset().mockReturnValue(undefined);
  mockCore.takePrompt.mockReturnValue(undefined);
  changed = jest.fn(); send = jest.fn<boolean, [string]>(() => true);
  session = new VoiceConversation(target, send, changed, () => Promise.resolve(mockCore as unknown as NativeVoiceChat));
});
afterEach(async () => { await session.close(); mockInputListeners.clear(); mockAppListeners.clear(); mockTranscriptListeners.clear(); mockCallEvents.clear(); jest.clearAllTimers(); jest.useRealTimers(); });

function emitEffects(...batch: VoiceSpeechEffect[]) {
  for (const effect of batch) {
    if (effect.type === 'start') mockActiveTokens.add(effect.token);
    if (effect.type === 'stop') mockActiveTokens.delete(effect.token);
  }
  mockEffects.push(...batch);
  mockNotify();
}
const start = (token: string, filler = false): VoiceSpeechEffect => ({ type: 'start', token, filler });
const speak = (token: string, text: string, chunk = '1', filler = false): VoiceSpeechEffect => ({ type: 'speak', token, text, chunk, filler, messageId: 'original-reply', partId: 'original-part', startUtf16: 42 });

test('starts without downloading and uses the shared strictly local recognizer', async () => {
  await session.start(); await flush();
  expect(changed.mock.calls.at(-1)?.[0].error).toBeNull();
  expect(mockCore.prepare).toHaveBeenCalledWith(false);
  expect(mockInput.start).toHaveBeenCalledWith(expect.objectContaining({ localOnly: true, audioCapture: expect.objectContaining({ open: expect.any(Function), close: expect.any(Function) }) }));
  expect(mockSpeech.startVoiceCall.mock.invocationCallOrder[0]).toBeLessThan(mockInput.start.mock.invocationCallOrder[0]);
  mockNotify();
  expect(mockRequest!.audioCapture.open()).toBe('101');
  expect(mockCore.openAudioCapture).toHaveBeenCalledWith(1n);
  expect(mockCore.audio).not.toHaveBeenCalled();
  mockRequest!.append('Recognized words');
  expect(mockCore.recognition).toHaveBeenCalledWith(1n, 'Recognized words');
  expect(send).not.toHaveBeenCalled();
});

test('plays the ready piano once after the recognizer is listening', async () => {
  mockInput.start.mockImplementationOnce(request => {
    mockRequest = request;
    mockInputSnapshot = { owner: request.owner, phase: 'preparing', interimText: '' };
    for (const listener of mockInputListeners) listener();
    return Promise.resolve();
  });
  await session.start(); await flush();
  expect(mockSpeech.playVoiceCallSound).not.toHaveBeenCalled();
  mockInputSnapshot.phase = 'listening';
  for (const listener of mockInputListeners) listener();
  await flush();
  expect(mockSpeech.playVoiceCallSound.mock.calls).toEqual([['file:///ready.mp3', true]]);
  for (const listener of mockInputListeners) listener();
  await session.skip(); await flush();
  expect(mockSpeech.playVoiceCallSound).toHaveBeenCalledTimes(1);
});

test('plays the closing piano once after hanging up and releasing capture', async () => {
  await session.start(); await flush();
  await Promise.all([session.close(), session.close()]);
  expect(mockSpeech.playVoiceCallSound.mock.calls).toEqual([
    ['file:///ready.mp3', true], ['file:///closed.mp3', false],
  ]);
  expect(mockSpeech.endVoiceCall.mock.invocationCallOrder[0]).toBeLessThan(mockSpeech.playVoiceCallSound.mock.invocationCallOrder[1]);
  expect(mockInput.cancel.mock.invocationCallOrder[0]).toBeLessThan(mockSpeech.playVoiceCallSound.mock.invocationCallOrder[1]);
});

test('a ready sound still loading at hangup cannot play over the closing piano', async () => {
  let loaded!: (uri: string) => void;
  jest.mocked(loadVoiceCallSound).mockImplementationOnce(() => new Promise(resolve => { loaded = resolve; }));
  await session.start(); await flush();
  await session.close();
  loaded('file:///late-ready.mp3'); await flush();
  expect(mockSpeech.playVoiceCallSound.mock.calls).toEqual([['file:///closed.mp3', false]]);
});

test('a piano playback failure does not interrupt listening or prevent hangup', async () => {
  mockSpeech.playVoiceCallSound.mockRejectedValueOnce(new Error('Audio unavailable'));
  await session.start(); await flush();
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'listening', error: null }));
  expect(mockSpeech.endVoiceCall).not.toHaveBeenCalled();
  await session.close();
  expect(mockInput.releaseReservation).toHaveBeenCalled();
  expect(mockSpeech.playVoiceCallSound).toHaveBeenLastCalledWith('file:///closed.mp3', false);
});

test('stops a ready piano that is still playing when a prompt is submitted', async () => {
  let finishSound!: () => void;
  mockSpeech.playVoiceCallSound.mockImplementationOnce(() => new Promise(resolve => { finishSound = resolve; }));
  await session.start(); await flush();
  mockCore.submitText.mockImplementationOnce(() => { mockView.phase = 'waiting'; });
  session.submitted('Hello');
  await flush();
  expect(mockSpeech.stopVoiceCallSound).toHaveBeenCalledTimes(1);
  finishSound(); await flush();
  expect(mockSpeech.playVoiceCallSound.mock.calls).toEqual([['file:///ready.mp3', true]]);
});

test('an audio interruption does not play the closing piano over another call', async () => {
  await session.start(); await flush();
  const token = (mockSpeech.startVoiceCall.mock.calls[0] as unknown as [string])[0];
  mockCallEvents.get('WhipVoiceCall')!({ token, type: 'audioInactive' });
  await session.close();
  expect(mockSpeech.playVoiceCallSound.mock.calls).toEqual([['file:///ready.mp3', true]]);
  expect(mockSpeech.stopVoiceCallSound).toHaveBeenCalled();
});

test('keeps background execution alive until voice call cleanup finishes', async () => {
  await session.start(); await flush();
  const token = (mockSpeech.startVoiceCall.mock.calls[0] as unknown as [string])[0];
  const finished = jest.fn();
  const background = runVoiceCallBackground({ token }).then(finished);
  await flush();
  expect(finished).not.toHaveBeenCalled();
  await session.close();
  await background;
  expect(finished).toHaveBeenCalledTimes(1);
});

test('suppresses status alerts for the call tab until hangup', async () => {
  await session.start(); await flush();
  expect(suppressAgentAlertsForTab).toHaveBeenCalledWith(expect.any(String), target.hostId, target.tabId);
  session.toggleMuted();
  await flush();
  expect(mockReleaseAlerts).not.toHaveBeenCalled();
  await session.close();
  expect(mockReleaseAlerts).toHaveBeenCalledTimes(1);
});

test('releases status alerts when starting the call fails', async () => {
  mockSpeech.startVoiceCall.mockRejectedValueOnce(new Error('Call unavailable'));
  await session.start(); await flush();
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'error' }));
  expect(mockReleaseAlerts).toHaveBeenCalledTimes(1);
  expect(mockSpeech.playVoiceCallSound).not.toHaveBeenCalled();
});

test('applies the selected VAD sensitivity before capture and updates it during a call', async () => {
  session.setVadSensitivity(75);
  await session.start(); await flush();
  expect(mockCore.setVadSensitivity).toHaveBeenCalledWith(75);
  expect(mockCore.setVadSensitivity.mock.invocationCallOrder[0]).toBeLessThan(mockInput.start.mock.invocationCallOrder[0]);
  session.setVadSensitivity(25);
  expect(mockCore.setVadSensitivity).toHaveBeenLastCalledWith(25);
  await session.close();
  session.setVadSensitivity(50);
  expect(mockCore.setVadSensitivity).toHaveBeenCalledTimes(2);
});

test('starting a call only checks the optional model and never downloads it', async () => {
  await session.start(); await flush();
  expect(mockCore.prepare).toHaveBeenCalledTimes(1);
  expect(mockCore.prepare).toHaveBeenCalledWith(false);
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'listening', error: null }));
  expect(mockInput.releaseReservation).not.toHaveBeenCalled();
});

test('closing during turn inference rejects its late result and releases speech ownership', async () => {
  let resolve!: () => void;
  mockCore.analyze.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  await session.start(); await flush();
  mockView.analyze = true;
  mockNotify();
  await session.close();
  const calls = changed.mock.calls.length;
  resolve(); await flush();
  expect(changed).toHaveBeenCalledTimes(calls);
  expect(mockInput.cancel).toHaveBeenCalled();
  expect(mockInput.releaseReservation).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
});

test('system-managed calls keep listening in the background and end from system controls', async () => {
  await session.start(); await flush();
  for (const listener of mockAppListeners) listener('background');
  await flush();
  expect(mockInput.cancel).not.toHaveBeenCalled();
  expect(mockInput.start).toHaveBeenCalledWith(expect.objectContaining({ managedCall: true }));
  const token = (mockSpeech.startVoiceCall.mock.calls[0] as unknown as [string])[0];
  mockCallEvents.get('WhipVoiceCall')!({ token, type: 'ended' });
  await flush();
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'closed' }));
  expect(mockInput.cancel).toHaveBeenCalled();
  expect(mockInput.releaseReservation).toHaveBeenCalled();
  expect(mockSpeech.endVoiceCall).toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('hangs up the system call while recognition shutdown is still draining', async () => {
  await session.start(); await flush();
  mockInput.cancel.mockImplementationOnce(() => {});
  const closing = session.close();
  expect(mockSpeech.endVoiceCall).toHaveBeenCalledTimes(1);
  expect(mockInput.releaseReservation).not.toHaveBeenCalled();
  await flush();
  expect(mockSpeech.playVoiceCallSound).toHaveBeenLastCalledWith('file:///closed.mp3', false);
  mockInputSnapshot = { owner: null, phase: 'idle', interimText: '' };
  for (const listener of mockInputListeners) listener();
  await closing;
  expect(mockInput.releaseReservation).toHaveBeenCalledTimes(1);
});

test('a replacement call waits for the previous call to release its microphone', async () => {
  await session.start(); await flush();
  mockInput.cancel.mockImplementationOnce(() => {});
  const replaced = session;
  session = new VoiceConversation({ ...target, bindingToken: 'other-chat', paneId: 'other-pane', tabId: 'other-tab' }, send, jest.fn(), () => Promise.resolve(mockCore as unknown as NativeVoiceChat));
  const starting = session.start();
  await flush();
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'closed' }));
  expect(mockSpeech.endVoiceCall).toHaveBeenCalledTimes(1);
  expect(mockSpeech.startVoiceCall).toHaveBeenCalledTimes(1);
  expect(mockInput.reserve).toHaveBeenCalledTimes(1);

  let released = false;
  const closing = replaced.close().then(() => { released = true; });
  await flush();
  expect(released).toBe(false);
  mockInputSnapshot = { owner: null, phase: 'idle', interimText: '' };
  for (const listener of mockInputListeners) listener();
  await closing; await starting; await flush();
  expect(mockInput.releaseReservation).toHaveBeenCalledTimes(1);
  expect(mockSpeech.startVoiceCall).toHaveBeenCalledTimes(2);
  expect(mockInput.reserve).toHaveBeenCalledTimes(2);
  expect(mockInput.releaseReservation.mock.invocationCallOrder[0]).toBeLessThan(mockInput.reserve.mock.invocationCallOrder[1]);
});

test('the system mute control drives Rust capture state', async () => {
  await session.start(); await flush();
  const token = (mockSpeech.startVoiceCall.mock.calls[0] as unknown as [string])[0];
  mockCallEvents.get('WhipVoiceCall')!({ token, type: 'muted', muted: true });
  expect(mockCore.setMuted).toHaveBeenCalledWith(true);
  session.toggleMuted(); await flush();
  expect(mockSpeech.setVoiceCallMuted).toHaveBeenCalledWith(token, true);
});

test('connects the native source before Chat View exists and binding updates only affect presentation', async () => {
  session = new VoiceConversation({ ...target, bindingToken: undefined }, send, changed, () => Promise.resolve(mockCore as unknown as NativeVoiceChat));
  await session.start(); await flush();
  expect(mockCore.connect).toHaveBeenCalledWith(target.localSource, expect.any(Function), expect.any(Number));
  expect(mockTranscriptListeners.size).toBe(0);
  session.setTranscriptBinding();
  session.setTranscriptBinding('replacement');
  mockView.phase = 'waiting'; mockNotify();
  expect(mockCore.connect).toHaveBeenCalledTimes(1);
  expect(mockSpeech.endVoiceCall).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('native source timeout surfaces an actionable error and releases the call', async () => {
  await session.start(); await flush();
  mockView.audioError = 'The agent transcript did not connect. Reopen voice chat to retry.';
  mockNotify(); await flush();
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'error', error: mockView.audioError }));
  expect(mockSpeech.endVoiceCall).toHaveBeenCalledTimes(1);
});

test('Rust effects retain original source offsets and acknowledge actual audio drain', async () => {
  let finish!: () => void;
  mockSpeech.enqueueChatSpeechWithSource = jest.fn<Promise<void>, [string, string, string]>(() => new Promise<void>(resolve => { finish = resolve; }));
  await session.start(); await flush();
  mockView.phase = 'speaking';
  emitEffects(start('reply')); await flush();
  expect(mockCore.acknowledgeSpeech).toHaveBeenCalledWith('reply', '0', 'started');
  emitEffects(speak('reply', 'First reply.', '9')); await flush();
  const source = JSON.parse(mockSpeech.enqueueChatSpeechWithSource.mock.calls[0][2]) as { chat: unknown };
  expect(source.chat).toEqual({ messageId: 'original-reply', partId: 'original-part', startUtf16: 42, bindingTokens: ['chat'], hostId: 'host', paneId: 'pane' });
  expect(mockCore.acknowledgeSpeech).not.toHaveBeenCalledWith('reply', '9', 'played');
  finish(); await flush();
  expect(mockCore.acknowledgeSpeech).toHaveBeenCalledWith('reply', '9', 'played');
  expect(mockCore.playbackEnded).not.toHaveBeenCalled();
  expect(mockSpeech.stopChatSpeech).not.toHaveBeenCalled();
  emitEffects({ type: 'stop', token: 'reply' }); await flush();
  expect(mockSpeech.stopChatSpeech).toHaveBeenCalledWith('reply');
});

test('a cancelled filler with stalled startup and stop cannot hold a real reply', async () => {
  let finishStartup!: () => void;
  mockSpeech.startLocalChatSpeech.mockImplementationOnce(() => new Promise<void>(resolve => { finishStartup = resolve; }));
  mockSpeech.stopChatSpeech.mockImplementationOnce(() => new Promise<void>(() => {}));
  await session.start(); await flush();
  mockView.phase = 'waiting';
  emitEffects(start('filler', true)); await flush();
  mockView.phase = 'speaking';
  emitEffects({ type: 'stop', token: 'filler' }, start('reply')); await flush();
  emitEffects(speak('reply', 'Actual answer.')); await flush();
  expect(mockSpeech.speakChat).toHaveBeenCalledWith('reply', 'Actual answer.');
  finishStartup(); await flush();
  expect(mockCore.acknowledgeSpeech).not.toHaveBeenCalledWith('filler', '0', 'started');
  expect(mockSpeech.stopChatSpeech).toHaveBeenLastCalledWith('filler');
});

test('late filler audio completion and level callbacks are fenced after preemption', async () => {
  let finishFiller!: () => void;
  mockSpeech.speakChat.mockImplementationOnce(() => new Promise<void>(resolve => { finishFiller = resolve; }));
  await session.start(); await flush();
  mockView.phase = 'waiting';
  emitEffects(start('filler', true)); await flush();
  emitEffects(speak('filler', 'Hmm.', '1', true)); await flush();
  mockView.phase = 'speaking';
  emitEffects({ type: 'stop', token: 'filler' }, start('reply')); await flush();
  finishFiller(); await flush();
  expect(mockCore.acknowledgeSpeech).not.toHaveBeenCalledWith('filler', '1', 'played');
  const count = changed.mock.calls.length;
  mockCallEvents.get('WhipChatSpeechLevel')!({ token: 'filler', type: '', level: 1 });
  expect(changed).toHaveBeenCalledTimes(count);
  expect(changed.mock.calls.at(-1)?.[0].messages).toBeUndefined();
});

test('word highlighting uses native positions and rejects events for a revoked lease', async () => {
  mockSpeech.enqueueChatSpeechWithSource = jest.fn<Promise<void>, [string, string, string]>(() => new Promise<void>(() => {}));
  await session.start(); await flush();
  mockView.phase = 'speaking';
  emitEffects(start('reply')); await flush();
  emitEffects(speak('reply', 'Hello local voice.')); await flush();
  const source = JSON.parse(mockSpeech.enqueueChatSpeechWithSource.mock.calls[0][2]) as Record<string, unknown>;
  const emit = mockCallEvents.get('WhipSpeechCaption') as unknown as (json: string) => void;
  mockCaptionSnapshot = JSON.stringify({ id: 1, sessionId: 'reply', local: { token: 'reply', messageId: source.messageId, startUtf16: 0 },
    text: 'Hello local voice.', spokenEndUtf16: 6, startUtf16: 0, phase: 'speaking' });
  emit('null');
  expect(changed.mock.calls.at(-1)?.[0].messages?.[0]).toEqual(expect.objectContaining({ active: true, spokenUtf16: 6 }));
  emitEffects({ type: 'stop', token: 'reply' });
  const count = changed.mock.calls.length;
  mockCaptionSnapshot = JSON.stringify({ ...JSON.parse(mockCaptionSnapshot), spokenEndUtf16: 12 });
  emit('null');
  expect(changed).toHaveBeenCalledTimes(count);
});

test('typed composer input is followed through Rust without dispatching twice', async () => {
  await session.start(); await flush();
  session.submitted('Typed follow-up'); await flush();
  expect(mockCore.submitText).toHaveBeenCalledWith('Typed follow-up');
  expect(send).not.toHaveBeenCalled();
});

test('an incompatible effect version cannot prevent hanging up and releasing the microphone', async () => {
  await session.start(); await flush();
  mockCore.takeEffects.mockImplementationOnce(() => { throw new Error('Unsupported Local voice effect version'); });
  await session.close();
  expect(mockSpeech.endVoiceCall).toHaveBeenCalledTimes(1);
  expect(mockInput.releaseReservation).toHaveBeenCalledTimes(1);
});
