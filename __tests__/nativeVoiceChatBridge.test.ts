import { NativeVoiceChat } from '../packages/react-native-whip-ssh/src/voiceChat';
import type { AgentChatState } from '../src/agentChat';

let mockWaiting = false;
const mockTranscript = jest.fn((_agent: number, live: boolean, baseline: boolean) => {
  // The native controller rejects disconnections and replacing an in-flight
  // conversation. A routine fetch must not masquerade as either operation.
  if (!live) throw new Error('Disconnected');
  if (baseline && mockWaiting) throw new Error('Conversation replaced');
});
jest.mock('../packages/react-native-whip-ssh/src/generated-entry', () => ({
  VoiceChat: jest.fn(() => ({ transcript: mockTranscript })),
  AgentTranscriptKind: { Claude: 0, Codex: 1, OpenCode: 2, Pi: 3 },
  VoiceChatPhase: { Setup: 0, Preparing: 1, Listening: 2, Finishing: 3, Waiting: 4, Speaking: 5, Muted: 6, Closed: 7 },
}));
jest.mock('../packages/react-native-whip-ssh/src/chatSpeech', () => ({ speechMessages: () => [] }));

const state: AgentChatState = { sessionId: 'conversation', status: 'live', transcript: { sessionId: 'conversation', turns: [], messages: [] } };
beforeEach(() => { jest.clearAllMocks(); mockWaiting = false; });

test('agent activity refreshes and repeated snapshots keep the same conversation connected', () => {
  const call = new NativeVoiceChat('/model-cache');
  call.transcript('codex', state, true);
  mockWaiting = true;
  for (const status of ['stale', 'loading', 'live'] as const) {
    expect(() => call.transcript('codex', { ...state, status }, true)).not.toThrow();
  }
});

test('the first transcript can arrive after submitting a new agent’s first prompt', () => {
  const call = new NativeVoiceChat('/model-cache');
  mockWaiting = true;
  expect(() => call.transcript('codex', state, false)).not.toThrow();
});

test.each(['claude', 'codex', 'opencode', 'pi'] as const)('%s waits for the whole turn outcome through idle gaps between assistant segments', agent => {
  const call = new NativeVoiceChat('/model-cache');
  const turn = {
    id: 'current-turn', status: 'idle' as const, diffs: [],
    assistants: [{ id: 'reply', role: 'assistant' as const, parts: [], diffs: [], completedAt: 1 }],
  };
  const update = (outcome?: 'completed') => ({
    ...state,
    transcript: { ...state.transcript, turns: [{ ...turn, details: { outcome } }] },
  });
  call.transcript(agent, update(), true);
  expect(mockTranscript).toHaveBeenLastCalledWith(expect.any(Number), true, true, [expect.objectContaining({ completed: false })]);
  mockWaiting = true;
  call.transcript(agent, update(), false);
  expect(mockTranscript).toHaveBeenLastCalledWith(expect.any(Number), true, false, [expect.objectContaining({ completed: false })]);
  call.transcript(agent, update('completed'), false);
  expect(mockTranscript).toHaveBeenLastCalledWith(expect.any(Number), true, false, [expect.objectContaining({ completed: true })]);
});

test('an actual conversation replacement still prevents speaking another conversation’s reply', () => {
  const call = new NativeVoiceChat('/model-cache');
  call.transcript('codex', state, true);
  mockWaiting = true;
  expect(() => call.transcript('codex', { ...state, sessionId: 'another-conversation' }, false)).toThrow('Conversation replaced');
});

test('a removed transcript is distinct from a routine activity refresh', () => {
  const call = new NativeVoiceChat('/model-cache');
  call.transcript('codex', state, true);
  expect(() => call.transcript('codex', { ...state, status: 'unavailable' }, false)).toThrow('Disconnected');
});
