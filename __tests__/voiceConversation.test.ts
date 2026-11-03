import { VoiceConversation, type VoiceConversationView } from '../src/services/voiceConversation';
import { recordDiagnostic } from '../src/services/diagnosticFormatting';
import type { AgentChatState } from '../src/agentChat';
import type { NativeVoiceChat } from 'react-native-whip-ssh/src/voiceChat';
import { suppressAgentAlertsForTab } from '../src/services/alerts';
import { runVoiceCallBackground } from '../src/services/voiceCallBackground';

const mockReleaseAlerts = jest.fn();
jest.mock('../src/services/alerts', () => ({
  suppressAgentAlertsForTab: jest.fn(() => mockReleaseAlerts),
}));

const mockInputListeners = new Set<() => void>();
const mockAppListeners = new Set<(state: string) => void>();
const mockCallEvents = new Map<string, (event: { token: string; type: string; muted?: boolean; reason?: string; error?: string; level?: number }) => void>();
const mockTranscriptListeners = new Set<(state: AgentChatState | null, baseline?: boolean) => void>();
let mockInputSnapshot = { owner: null as string | null, phase: 'idle', interimText: '' };
let mockView = { phase: 'preparing', inputId: 1n, muted: false, smartTurn: false, text: '', level: 0, silenceMs: 800, progress: 0, analyze: false };
let mockRequest: {
  owner: string; localOnly: boolean; duringPlayback?: boolean; append: (text: string) => void;
  onAudio: (pcm: string) => void; onError: (error: string, message: string) => void;
} | undefined;
const mockCore = {
  submitText: jest.fn(),
  view: jest.fn(() => mockView),
  speechFinished: jest.fn(() => true),
  skipResponse: jest.fn(() => { mockView.phase = "listening"; mockView.inputId += 1n; }),
  prepare: jest.fn((_install: boolean) => { mockView.phase = 'listening'; return Promise.resolve(); }),
  beginPreparation: jest.fn(() => { mockView.phase = 'preparing'; }),
  useVad: jest.fn(() => { mockView.phase = 'listening'; }),
  audio: jest.fn(), analyze: jest.fn(() => Promise.resolve()), recognition: jest.fn(),
  ended: jest.fn(), takePrompt: jest.fn(), transcript: jest.fn(), nextSpeech: jest.fn(),
  playbackEnded: jest.fn(() => { mockView.phase = 'listening'; }),
  setMuted: jest.fn(), finish: jest.fn(), close: jest.fn(),
  setVadSensitivity: jest.fn(),
};
const mockSpeech = {
  startVoiceCall: jest.fn(() => Promise.resolve()), endVoiceCall: jest.fn(() => Promise.resolve()),
  setVoiceCallMuted: jest.fn(() => Promise.resolve()), setVoiceCallSpeaker: jest.fn(() => Promise.resolve()),
  startLocalChatSpeech: jest.fn(() => Promise.resolve()), speakChat: jest.fn((_token: string, _text: string) => Promise.resolve()),
  enqueueChatSpeech: undefined as jest.Mock<Promise<void>, [string, string]> | undefined,
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
const target = { agent: 'codex' as const, bindingToken: 'chat', hostId: 'host', paneId: 'pane', tabId: 'tab', label: 'Codex' };
const state: AgentChatState = { sessionId: 'session', status: 'live', transcript: { sessionId: 'session', turns: [], messages: [] } };
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
let session: VoiceConversation;
let changed: jest.Mock<void, [VoiceConversationView]>;
let send: jest.Mock<boolean, [string]>;
beforeEach(() => {
  jest.clearAllMocks();
  mockSpeech.enqueueChatSpeech = undefined;
  mockInputSnapshot = { owner: null, phase: 'idle', interimText: '' };
  mockView = { phase: 'preparing', inputId: 1n, muted: false, smartTurn: false, text: '', level: 0, silenceMs: 800, progress: 0, analyze: false };
  mockRequest = undefined;
  mockCore.speechFinished.mockReturnValue(true);
  mockCore.nextSpeech.mockReset().mockReturnValue(undefined);
  mockCore.takePrompt.mockReturnValue(undefined);
  changed = jest.fn(); send = jest.fn<boolean, [string]>(() => true);
  session = new VoiceConversation(target, send, changed, () => Promise.resolve(mockCore as unknown as NativeVoiceChat));
});
afterEach(async () => { await session.close(); mockInputListeners.clear(); mockAppListeners.clear(); mockTranscriptListeners.clear(); mockCallEvents.clear(); });

test('starts without downloading and uses the shared strictly local recognizer', async () => {
  await session.start(); await flush();
  expect(changed.mock.calls.at(-1)?.[0].error).toBeNull();
  expect(mockCore.prepare).toHaveBeenCalledWith(false);
  expect(mockInput.start).toHaveBeenCalledWith(expect.objectContaining({ localOnly: true, onAudio: expect.any(Function) }));
  expect(mockSpeech.startVoiceCall.mock.invocationCallOrder[0]).toBeLessThan(mockInput.start.mock.invocationCallOrder[0]);
  mockRequest!.onAudio('AAAA');
  expect(mockCore.audio).toHaveBeenCalledWith(1n, 'AAAA');
  mockRequest!.append('Recognized words');
  expect(mockCore.recognition).toHaveBeenCalledWith(1n, 'Recognized words');
  expect(send).not.toHaveBeenCalled();
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
});

test('a new agent can receive its first spoken prompt before its transcript exists', async () => {
  session = new VoiceConversation({ ...target, bindingToken: undefined }, send, changed, () => Promise.resolve(mockCore as unknown as NativeVoiceChat));
  await session.start(); await flush();
  expect(mockTranscriptListeners.size).toBe(0);
  expect(mockInput.start).toHaveBeenCalled();
  mockView.phase = 'waiting';
  mockCore.takePrompt.mockReturnValueOnce('First spoken prompt');
  mockRequest!.onAudio('AAAA');
  expect(send).toHaveBeenCalledWith('First spoken prompt');

  session.setTranscriptBinding('first-transcript');
  for (const listener of mockTranscriptListeners) listener(state, true);
  expect(mockCore.transcript).toHaveBeenLastCalledWith('codex', state, false);
  expect(mockSpeech.startVoiceCall).toHaveBeenCalledTimes(1);
  expect(mockSpeech.endVoiceCall).not.toHaveBeenCalled();
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'waiting', transcript: state, error: null }));
  await session.close();
  expect(mockTranscriptListeners.size).toBe(0);
});

test('a binding invalidation preserves the pending reply until the replacement transcript arrives', async () => {
  await session.start(); await flush();
  mockView.phase = 'waiting';
  mockCore.takePrompt.mockReturnValueOnce('First spoken prompt');
  mockRequest!.onAudio('AAAA');
  for (const listener of mockTranscriptListeners) listener(null);
  session.setTranscriptBinding();
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'waiting', error: null }));
  expect(mockSpeech.endVoiceCall).not.toHaveBeenCalled();
  expect(mockCore.close).not.toHaveBeenCalled();

  session.setTranscriptBinding('replacement-transcript');
  mockView.phase = 'speaking';
  mockView.inputId += 1n;
  mockCore.nextSpeech.mockReturnValueOnce('The first reply.');
  for (const listener of mockTranscriptListeners) listener(state, true);
  await flush();
  expect(send).toHaveBeenCalledTimes(1);
  expect(mockSpeech.speakChat).toHaveBeenCalledTimes(1);
  expect(mockSpeech.speakChat).toHaveBeenCalledWith(expect.any(String), 'The first reply.');
  expect(mockSpeech.startVoiceCall).toHaveBeenCalledTimes(1);
  expect(mockSpeech.endVoiceCall).not.toHaveBeenCalled();
});

test('a binding that never returns ends the call after the recovery deadline', async () => {
  jest.useFakeTimers();
  try {
    await session.start(); await flush();
    mockView.phase = 'waiting';
    mockRequest!.onAudio('AAAA');
    for (const listener of mockTranscriptListeners) listener(null);
    await jest.advanceTimersByTimeAsync(29_000);
    expect(mockSpeech.endVoiceCall).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'error', error: expect.stringContaining('transcript did not reconnect') }));
    expect(mockSpeech.endVoiceCall).toHaveBeenCalledTimes(1);
  } finally {
    await session.close();
    jest.useRealTimers();
  }
});

test('a replacement transcript clears the recovery deadline', async () => {
  jest.useFakeTimers();
  try {
    await session.start(); await flush();
    for (const listener of mockTranscriptListeners) listener(null);
    session.setTranscriptBinding('replacement-transcript');
    for (const listener of mockTranscriptListeners) listener(state, true);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(mockSpeech.endVoiceCall).not.toHaveBeenCalled();
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'listening', error: null }));
  } finally {
    await session.close();
    jest.useRealTimers();
  }
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

test('submits the finalized transcript once through the existing send callback', async () => {
  await session.start(); await flush();
  mockCore.ended.mockImplementationOnce(() => { mockView.phase = 'waiting'; });
  mockCore.takePrompt.mockReturnValueOnce('Hello agent');
  mockInputSnapshot = { owner: null, phase: 'idle', interimText: '' };
  for (const listener of mockInputListeners) listener();
  for (const listener of mockTranscriptListeners) listener(state);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('Hello agent');
});

test('playback uses the existing selected-voice player and releases capture first', async () => {
  await session.start(); await flush();
  mockView.phase = 'speaking';
  mockCore.nextSpeech.mockReturnValueOnce('Reply text');
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  expect(mockInput.cancel.mock.invocationCallOrder[0]).toBeLessThan(mockSpeech.startLocalChatSpeech.mock.invocationCallOrder[0]);
  expect(mockSpeech.speakChat).toHaveBeenCalledWith(expect.any(String), 'Reply text');
  expect(mockSpeech.stopChatSpeech).toHaveBeenCalled();
  expect(mockInput.start).toHaveBeenCalledTimes(2);
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
  mockRequest!.onAudio('AAAA');
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

test('skipping playback cannot restart speech when a transcript update arrives during stop', async () => {
  let finishSpeech!: () => void;
  let finishStop!: () => void;
  mockSpeech.speakChat.mockImplementationOnce(() => new Promise<void>(resolve => { finishSpeech = resolve; }));
  await session.start(); await flush();
  mockView.phase = 'speaking';
  mockCore.nextSpeech.mockReturnValueOnce('Reply text');
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  mockSpeech.stopChatSpeech.mockImplementationOnce(() => new Promise<void>(resolve => { finishStop = resolve; }));
  const skipped = session.skip();
  for (const listener of mockTranscriptListeners) listener(state);
  expect(mockSpeech.startLocalChatSpeech).toHaveBeenCalledTimes(1);
  finishStop(); await skipped;
  finishSpeech(); await flush();
  expect(mockSpeech.startLocalChatSpeech).toHaveBeenCalledTimes(1);
  expect(mockInput.start).toHaveBeenCalledTimes(3);
});

test('closing a call before activation prevents late activation from opening the microphone', async () => {
  let activate!: () => void;
  mockSpeech.startVoiceCall.mockImplementationOnce(() => new Promise<void>(resolve => { activate = resolve; }));
  const starting = session.start(); await flush();
  for (const listener of mockTranscriptListeners) listener(state);
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'starting' }));
  await session.close();
  expect(mockSpeech.endVoiceCall).toHaveBeenCalled();
  activate(); await starting; await flush();
  expect(mockInput.start).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('speaks streamed prose before completion and keeps one player across generation gaps', async () => {
  mockCore.speechFinished.mockReturnValue(false);
  await session.start(); await flush();
  mockView.phase = 'speaking'; mockView.inputId += 1n;
  mockCore.nextSpeech.mockReturnValueOnce('First sentence.');
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  expect(mockSpeech.speakChat).toHaveBeenCalledWith(expect.any(String), 'First sentence.');
  expect(mockSpeech.stopChatSpeech).not.toHaveBeenCalled();
  expect(mockInput.start).toHaveBeenLastCalledWith(expect.objectContaining({ duringPlayback: true, localOnly: true }));
  mockCore.nextSpeech.mockReturnValueOnce('Second sentence.');
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  expect(mockSpeech.speakChat).toHaveBeenLastCalledWith(expect.any(String), 'Second sentence.');
  expect(mockSpeech.startLocalChatSpeech).toHaveBeenCalledTimes(1);
  expect(mockCore.playbackEnded).not.toHaveBeenCalled();
  mockCore.speechFinished.mockReturnValue(true);
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  expect(mockCore.playbackEnded).toHaveBeenCalledTimes(1);
});

test('voice interruption stops output and preserves the running recognizer and its first words', async () => {
  let finishSpeech!: () => void;
  mockSpeech.speakChat.mockImplementationOnce(() => new Promise<void>(resolve => { finishSpeech = resolve; }));
  await session.start(); await flush();
  mockView.phase = 'speaking'; mockView.inputId += 1n;
  mockCore.nextSpeech.mockReturnValueOnce('Assistant speaking.');
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  const capture = mockRequest!;
  const starts = mockInput.start.mock.calls.length;
  mockCore.audio.mockImplementationOnce(() => { mockView.phase = 'listening'; });
  capture.onAudio('user speech');
  await flush();
  expect(mockSpeech.stopChatSpeech).toHaveBeenCalledTimes(1);
  expect(mockInput.start).toHaveBeenCalledTimes(starts);
  capture.append('Actually, stop and do this instead');
  expect(mockCore.recognition).toHaveBeenLastCalledWith(mockView.inputId, 'Actually, stop and do this instead');
  finishSpeech(); await flush();
  expect(mockCore.playbackEnded).not.toHaveBeenCalled();
  expect(mockSpeech.startLocalChatSpeech).toHaveBeenCalledTimes(1);
});

test('skip suppresses the rest of an unfinished reply and waits for the agent before normal capture', async () => {
  mockCore.speechFinished.mockReturnValue(false);
  mockCore.skipResponse.mockImplementationOnce(() => { mockView.phase = 'waiting'; });
  await session.start(); await flush();
  mockView.phase = 'speaking'; mockView.inputId += 1n;
  mockCore.nextSpeech.mockReturnValueOnce('First sentence.');
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  await session.skip(); await flush();
  const starts = mockInput.start.mock.calls.length;
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  expect(mockInput.start).toHaveBeenCalledTimes(starts);
  expect(mockSpeech.startLocalChatSpeech).toHaveBeenCalledTimes(1);
  mockView.phase = 'listening'; mockView.inputId += 1n;
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  expect(mockInput.start).toHaveBeenLastCalledWith(expect.objectContaining({ duringPlayback: false }));
});

test('devices without echo cancellation retain explicit skip and normal local voice chat', async () => {
  mockInput.supportsPlaybackMonitoring.mockResolvedValueOnce(false);
  await session.start(); await flush();
  mockView.phase = 'speaking'; mockView.inputId += 1n;
  mockCore.nextSpeech.mockReturnValueOnce('Reply.');
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  expect(mockInput.start.mock.calls.some(([request]) => 'duringPlayback' in request && request.duringPlayback)).toBe(false);
  expect(mockSpeech.speakChat).toHaveBeenCalledWith(expect.any(String), 'Reply.');
});

test('latency uses a native playback-start event rather than TTS submission', async () => {
  let now = 1_000;
  const clock = jest.spyOn(performance, 'now').mockImplementation(() => now);
  let finishSpeech!: () => void;
  try {
    await session.start(); await flush();
    mockView.phase = 'finishing'; mockRequest!.onAudio('last packet');
    now = 1_050;
    mockCore.ended.mockImplementationOnce(() => { mockView.phase = 'waiting'; });
    mockCore.takePrompt.mockReturnValueOnce('Hello');
    mockInputSnapshot = { owner: null, phase: 'idle', interimText: '' };
    for (const listener of mockInputListeners) listener();
    now = 1_250;
    mockSpeech.speakChat.mockImplementationOnce(() => new Promise<void>(resolve => { finishSpeech = resolve; }));
    mockView.phase = 'speaking'; mockView.inputId += 1n;
    mockCore.nextSpeech.mockReturnValueOnce('Reply.');
    for (const listener of mockTranscriptListeners) listener(state);
    await flush();
    expect(recordDiagnostic).not.toHaveBeenCalledWith('info', 'VoiceChat', 'response-latency', expect.anything());
    now = 1_350;
    const token = (mockSpeech.startLocalChatSpeech.mock.calls[0] as unknown as [string])[0];
    mockCallEvents.get('WhipChatSpeechStarted')!({ token, type: '' });
    expect(recordDiagnostic).toHaveBeenCalledWith('info', 'VoiceChat', 'response-latency', {
      endpointMs: 800, recognitionMs: 50, agentMs: 200, proseToPlaybackMs: 100, ttsMs: 100, speechEndToPlaybackMs: 1_150,
    });
    finishSpeech(); await flush();
  } finally { clock.mockRestore(); }
});

test('a rejected echo-cancelled monitor keeps the reply and manual skip available', async () => {
  let finishSpeech!: () => void;
  mockSpeech.speakChat.mockImplementationOnce(() => new Promise<void>(resolve => { finishSpeech = resolve; }));
  await session.start(); await flush();
  mockView.phase = 'speaking'; mockView.inputId += 1n;
  mockCore.nextSpeech.mockReturnValueOnce('Reply.');
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  mockRequest!.onError('failed', 'Audio effect unavailable');
  await flush();
  expect(mockSpeech.stopChatSpeech).not.toHaveBeenCalled();
  expect(mockSpeech.endVoiceCall).not.toHaveBeenCalled();
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'speaking', error: expect.stringContaining('Use Skip') }));
  await session.skip();
  finishSpeech(); await flush();
  expect(mockInput.start).toHaveBeenLastCalledWith(expect.objectContaining({ duringPlayback: false, localOnly: true }));
});

test.each([
  { reason: 'shake' },
  { reason: 'interrupted' },
  { reason: 'stopped', error: 'Speech engine failed' },
])('a speech-player stop ($reason) keeps the call connected for the next turn', async event => {
  let finishSpeech!: () => void;
  mockSpeech.speakChat.mockImplementationOnce(() => new Promise<void>(resolve => { finishSpeech = resolve; }));
  await session.start(); await flush();
  mockView.phase = 'speaking'; mockView.inputId += 1n;
  mockCore.nextSpeech.mockReturnValueOnce('Hello.');
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  mockCore.skipResponse.mockImplementationOnce(() => { mockView.phase = 'waiting'; mockView.inputId += 1n; });
  const token = (mockSpeech.startLocalChatSpeech.mock.calls[0] as unknown as [string])[0];
  mockCallEvents.get('WhipChatSpeechStopped')!({ token, type: '', ...event });
  finishSpeech(); await flush();
  expect(mockSpeech.endVoiceCall).not.toHaveBeenCalled();
  expect(mockCore.close).not.toHaveBeenCalled();
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'waiting', error: event.error ?? null }));
  mockView.phase = 'listening'; mockView.inputId += 1n;
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  expect(mockInput.start).toHaveBeenLastCalledWith(expect.objectContaining({ localOnly: true, duringPlayback: false }));
  expect(mockSpeech.startVoiceCall).toHaveBeenCalledTimes(1);
});

test('a player initialization failure keeps the call available for another turn', async () => {
  mockSpeech.startLocalChatSpeech.mockRejectedValueOnce(new Error('Local voice unavailable'));
  await session.start(); await flush();
  mockCore.skipResponse.mockImplementationOnce(() => { mockView.phase = 'waiting'; });
  mockView.phase = 'speaking'; mockView.inputId += 1n;
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  expect(mockSpeech.endVoiceCall).not.toHaveBeenCalled();
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'waiting', error: 'Local voice unavailable' }));
});

test('typed composer input follows its reply in the same call without sending twice', async () => {
  await session.start(); await flush();
  mockCore.submitText.mockImplementationOnce(() => { mockView.phase = 'waiting'; mockView.inputId += 1n; });
  session.submitted('Typed follow-up'); await flush();
  expect(mockCore.submitText).toHaveBeenCalledWith('Typed follow-up');
  expect(send).not.toHaveBeenCalled();
  mockView.phase = 'speaking';
  mockCore.nextSpeech.mockReturnValueOnce('Answer to the typed message.');
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  expect(mockSpeech.speakChat).toHaveBeenCalledWith(expect.any(String), 'Answer to the typed message.');
  expect(mockSpeech.startVoiceCall).toHaveBeenCalledTimes(1);
  expect(mockSpeech.endVoiceCall).not.toHaveBeenCalled();
});

test('only the current player drives the speaking orb level', async () => {
  let finishSpeech!: () => void;
  mockSpeech.speakChat.mockImplementationOnce(() => new Promise<void>(resolve => { finishSpeech = resolve; }));
  await session.start(); await flush();
  mockView.phase = 'speaking'; mockView.inputId += 1n;
  mockCore.nextSpeech.mockReturnValueOnce('Hello.');
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  const token = (mockSpeech.startLocalChatSpeech.mock.calls[0] as unknown as [string])[0];
  mockCallEvents.get('WhipChatSpeechLevel')!({ token, type: '', level: 0.12 });
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ playbackLevel: 0.12 }));
  const updates = changed.mock.calls.length;
  mockCallEvents.get('WhipChatSpeechLevel')!({ token: 'stale', type: '', level: 1 });
  expect(changed).toHaveBeenCalledTimes(updates);
  finishSpeech(); await flush();
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ playbackLevel: 0 }));
});

test('a typed follow-up cancels pending playback and speaks only the new reply', async () => {
  let finishOldSpeech!: () => void;
  mockSpeech.speakChat.mockImplementationOnce(() => new Promise<void>(resolve => { finishOldSpeech = resolve; }));
  await session.start(); await flush();
  mockView.phase = 'speaking'; mockView.inputId += 1n;
  mockCore.nextSpeech.mockReturnValueOnce('Old reply.');
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  mockCore.submitText.mockImplementationOnce(() => { mockView.phase = 'waiting'; mockView.inputId += 1n; });
  session.submitted('Typed follow-up'); await flush();
  finishOldSpeech(); await flush();
  mockView.phase = 'speaking';
  mockCore.nextSpeech.mockReturnValueOnce('New reply.');
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  expect(mockSpeech.speakChat.mock.calls.map(call => call[1])).toEqual(['Old reply.', 'New reply.']);
  expect(send).not.toHaveBeenCalled();
  expect(mockSpeech.endVoiceCall).not.toHaveBeenCalled();
});

test('prepares one following utterance while audio plays and waits for every played fragment', async () => {
  const played: (() => void)[] = [];
  mockSpeech.enqueueChatSpeech = jest.fn<Promise<void>, [string, string]>(() => new Promise<void>(resolve => { played.push(resolve); }));
  await session.start(); await flush();
  mockView.phase = 'speaking'; mockView.inputId += 1n;
  mockCore.nextSpeech.mockReturnValueOnce('First.').mockReturnValueOnce('Second.').mockReturnValueOnce('Third.');
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  expect(mockSpeech.enqueueChatSpeech.mock.calls.map(([, text]) => text)).toEqual(['First.', 'Second.']);
  expect(mockSpeech.speakChat).not.toHaveBeenCalled();
  expect(mockCore.playbackEnded).not.toHaveBeenCalled();
  played[0](); await flush();
  expect(mockSpeech.enqueueChatSpeech.mock.calls.map(([, text]) => text)).toEqual(['First.', 'Second.', 'Third.']);
  played[1](); await flush();
  expect(mockCore.playbackEnded).not.toHaveBeenCalled();
  played[2](); await flush();
  expect(mockCore.playbackEnded).toHaveBeenCalledTimes(1);
  expect(mockSpeech.startLocalChatSpeech).toHaveBeenCalledTimes(1);
});

test('new streamed prose is prepared before the current utterance finishes playing', async () => {
  const played: (() => void)[] = [];
  mockSpeech.enqueueChatSpeech = jest.fn<Promise<void>, [string, string]>(() => new Promise<void>(resolve => { played.push(resolve); }));
  mockCore.speechFinished.mockReturnValue(false);
  await session.start(); await flush();
  mockView.phase = 'speaking'; mockView.inputId += 1n;
  mockCore.nextSpeech.mockReturnValueOnce('First.');
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  expect(played).toHaveLength(1);
  mockCore.nextSpeech.mockReturnValueOnce('Arrived later.');
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  expect(mockSpeech.enqueueChatSpeech.mock.calls.map(([, text]) => text)).toEqual(['First.', 'Arrived later.']);
  mockCore.speechFinished.mockReturnValue(true);
  played.forEach(resolve => resolve());
  await flush();
  expect(mockCore.playbackEnded).toHaveBeenCalledTimes(1);
});

test('skip cancels prepared speech and late playback completions cannot restart the reply', async () => {
  const played: (() => void)[] = [];
  mockSpeech.enqueueChatSpeech = jest.fn<Promise<void>, [string, string]>(() => new Promise<void>(resolve => { played.push(resolve); }));
  await session.start(); await flush();
  mockView.phase = 'speaking'; mockView.inputId += 1n;
  mockCore.nextSpeech.mockReturnValueOnce('First.').mockReturnValueOnce('Prepared.').mockReturnValueOnce('Never submit.');
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  await session.skip();
  played.forEach(resolve => resolve());
  await flush();
  expect(mockSpeech.enqueueChatSpeech).toHaveBeenCalledTimes(2);
  expect(mockSpeech.stopChatSpeech).toHaveBeenCalledTimes(1);
  expect(mockCore.playbackEnded).not.toHaveBeenCalled();
});

test('a failed prepared utterance stops the reply without leaving unhandled playback promises', async () => {
  const played: (() => void)[] = [];
  let fail!: (error: Error) => void;
  mockSpeech.enqueueChatSpeech = jest.fn<Promise<void>, [string, string]>()
    .mockImplementationOnce(() => new Promise<void>(resolve => { played.push(resolve); }))
    .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  await session.start(); await flush();
  mockView.phase = 'speaking'; mockView.inputId += 1n;
  mockCore.nextSpeech.mockReturnValueOnce('First.').mockReturnValueOnce('Failed preparation.');
  for (const listener of mockTranscriptListeners) listener(state);
  await flush();
  fail(new Error('Synthesis failed')); await flush();
  played[0](); await flush();
  expect(mockSpeech.stopChatSpeech).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ error: 'Synthesis failed' }));
});

describe('spoken waiting filler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(async () => { await session.close(); jest.useRealTimers(); });

  const waitForReply = async () => {
    await session.start(); await flush();
    mockView.phase = 'waiting'; mockView.inputId += 1n;
    for (const listener of mockTranscriptListeners) listener(state);
    await jest.advanceTimersByTimeAsync(7_000);
    expect(mockSpeech.speakChat).not.toHaveBeenCalled();
  };

  const offerFiller = async () => {
    mockCore.nextSpeech.mockReturnValueOnce('One moment.');
    await jest.advanceTimersByTimeAsync(1_000);
    await flush();
  };

  test('plays a native-selected filler locally without completing or submitting a turn', async () => {
    await waitForReply();
    await offerFiller();
    expect(mockSpeech.speakChat).toHaveBeenCalledWith(expect.stringContaining(':filler:'), 'One moment.');
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'waiting' }));
    expect(mockCore.playbackEnded).not.toHaveBeenCalled();
    expect(mockCore.skipResponse).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(recordDiagnostic).not.toHaveBeenCalledWith('info', 'VoiceChat', 'response-latency', expect.anything());
  });

  test('the real reply cuts off audible filler and then uses the shared player', async () => {
    await waitForReply();
    let finishFiller!: () => void;
    mockSpeech.speakChat.mockImplementationOnce(() => new Promise<void>(resolve => { finishFiller = resolve; }));
    await offerFiller();
    const fillerToken = mockSpeech.speakChat.mock.calls[0][0];
    mockSpeech.stopChatSpeech.mockImplementationOnce(() => { finishFiller(); return Promise.resolve(); });
    mockCore.nextSpeech.mockReturnValueOnce('The real reply.');
    mockView.phase = 'speaking';
    for (const listener of mockTranscriptListeners) listener(state);
    await flush();
    expect(mockSpeech.stopChatSpeech).toHaveBeenCalledWith(fillerToken);
    expect(mockSpeech.speakChat.mock.calls.map(([, text]) => text)).toEqual(['One moment.', 'The real reply.']);
    expect(mockCore.skipResponse).not.toHaveBeenCalled();
    expect(mockCore.playbackEnded).toHaveBeenCalledTimes(1);
  });

  test('a cancelled slow filler startup cannot replace or speak over the real reply', async () => {
    await waitForReply();
    let started!: () => void;
    mockSpeech.startLocalChatSpeech.mockImplementationOnce(() => new Promise<void>(resolve => { started = resolve; }));
    await offerFiller();
    mockView.phase = 'speaking';
    mockCore.nextSpeech.mockReturnValueOnce('The real reply.');
    for (const listener of mockTranscriptListeners) listener(state);
    await flush();
    expect(mockSpeech.speakChat).not.toHaveBeenCalled();
    started(); await flush();
    expect(mockSpeech.speakChat.mock.calls.map(([, text]) => text)).toEqual(['The real reply.']);
    expect(mockCore.skipResponse).not.toHaveBeenCalled();
  });

  test.each(['interrupt', 'hangup', 'skip'] as const)('%s cancels filler without late turn completion', async action => {
    await waitForReply();
    let finishFiller!: () => void;
    mockSpeech.speakChat.mockImplementationOnce(() => new Promise<void>(resolve => { finishFiller = resolve; }));
    await offerFiller();
    mockSpeech.stopChatSpeech.mockImplementationOnce(() => { finishFiller(); return Promise.resolve(); });
    if (action === 'hangup') await session.close();
    else if (action === 'skip') await session.skip();
    else {
      mockView.phase = 'listening';
      mockRequest!.onAudio('AAAA');
    }
    await flush();
    expect(mockSpeech.stopChatSpeech).toHaveBeenCalled();
    expect(mockCore.playbackEnded).not.toHaveBeenCalled();
    expect(mockCore.skipResponse).toHaveBeenCalledTimes(action === 'skip' ? 1 : 0);
    const polls = mockCore.nextSpeech.mock.calls.length;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockCore.nextSpeech).toHaveBeenCalledTimes(polls);
  });

  test('a filler failure leaves the pending agent response available', async () => {
    await waitForReply();
    mockSpeech.speakChat.mockRejectedValueOnce(new Error('Filler unavailable'));
    await offerFiller();
    expect(mockCore.skipResponse).not.toHaveBeenCalled();
    expect(mockSpeech.endVoiceCall).not.toHaveBeenCalled();
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'waiting', error: null }));
  });

  test('native filler stop events cannot skip the agent reply or report reply latency', async () => {
    await waitForReply();
    let finishFiller!: () => void;
    mockSpeech.speakChat.mockImplementationOnce(() => new Promise<void>(resolve => { finishFiller = resolve; }));
    await offerFiller();
    const token = mockSpeech.speakChat.mock.calls[0][0];
    mockCallEvents.get('WhipChatSpeechStarted')!({ token, type: '' });
    mockSpeech.stopChatSpeech.mockImplementationOnce(() => { finishFiller(); return Promise.resolve(); });
    mockCallEvents.get('WhipChatSpeechStopped')!({ token, type: '', reason: 'shake' });
    await flush();
    expect(mockCore.skipResponse).not.toHaveBeenCalled();
    expect(mockCore.playbackEnded).not.toHaveBeenCalled();
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'waiting', error: null }));
    expect(recordDiagnostic).not.toHaveBeenCalledWith('info', 'VoiceChat', 'response-latency', expect.anything());
  });
});
