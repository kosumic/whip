import { NativeVoiceChat, type LocalVoiceSource } from '../packages/react-native-whip-ssh/src/voiceChat';

const mockView = jest.fn(() => ({ phase: 2, downloadedBytes: 0n, totalBytes: 0n }));
const mockConnect = jest.fn();
const mockEffects = jest.fn(() => '[]');
const mockAck = jest.fn();
jest.mock('../packages/react-native-whip-ssh/src/generated-entry', () => ({
  VoiceChat: jest.fn(() => ({ view: mockView, connect: mockConnect, takeEffects: mockEffects, acknowledgeSpeech: mockAck })),
  AgentTranscriptKind: { Claude: 0, Codex: 1, OpenCode: 2, Pi: 3 },
  VoiceChatPhase: { Setup: 0, Preparing: 1, Listening: 2, Finishing: 3, Waiting: 4, Speaking: 5, Muted: 6, Closed: 7 },
}));
beforeEach(() => jest.clearAllMocks());

test('voice chat without a model reports zero download progress', () => {
  expect(new NativeVoiceChat('/model-cache').view()).toEqual(expect.objectContaining({ phase: 'listening', progress: 0 }));
});

test('optional model downloads retain their progress', () => {
  mockView.mockReturnValueOnce({ phase: 1, downloadedBytes: 50n, totalBytes: 100n });
  expect(new NativeVoiceChat('/model-cache').view()).toEqual(expect.objectContaining({ phase: 'preparing', progress: 0.5 }));
});

test('connects native owners and returns token-scoped playback acknowledgements', () => {
  const call = new NativeVoiceChat('/cache');
  const changed = jest.fn();
  const source: LocalVoiceSource = { runtimeId: 'runtime', incarnation: 7n, terminalId: 'terminal', paneId: 'pane', agent: 'codex' as const, queue: {} as LocalVoiceSource['queue'], targetKey: 'target' };
  call.connect(source, changed, 2);
  expect(mockConnect).toHaveBeenCalledWith('runtime', 7n, 'terminal', 'pane', source.queue, 'target', { changed }, 2, 1);
  const effect = { version: 1, type: 'speak', token: 'call-lease', chunk: '12', text: 'Hello.' };
  mockEffects.mockReturnValueOnce(JSON.stringify([effect]));
  expect(call.takeEffects()).toEqual([effect]);
  call.acknowledgeSpeech('call-lease', '12', 'played');
  expect(mockAck).toHaveBeenCalledWith('call-lease', 12n, 'played');
});


test('rejects an incompatible effect protocol before executing platform speech', () => {
  const call = new NativeVoiceChat('/cache');
  mockEffects.mockReturnValueOnce(JSON.stringify([{ version: 2, type: 'start', token: 'unknown' }]));
  expect(() => call.takeEffects()).toThrow('Unsupported Local voice effect version');
});
