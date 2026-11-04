import { canReadChatResponse, NativeChatSpeechQueue, NativeAutomaticChatSpeechQueue } from '../packages/react-native-whip-ssh/src/chatSpeech';
import type { NativeAgentTranscriptMessage } from '../packages/react-native-whip-ssh/src';

const mockUpdate = jest.fn();
const mockReadResponse = jest.fn();
const mockAvailable = jest.fn();
const mockNext = jest.fn();
const mockNextWithSource = jest.fn();
const mockDestroy = jest.fn();
const mockAutomatic = { update: jest.fn(), next: jest.fn(), dismissCurrent: jest.fn(), remove: jest.fn(), reset: jest.fn(), uniffiDestroy: jest.fn() };
jest.mock('../packages/react-native-whip-ssh/src/generated-entry', () => {
  function part(tag: string) {
    return function (this: { tag: string; inner: unknown }, inner: unknown) {
      this.tag = tag;
      this.inner = inner;
    };
  }
  return {
    AutomaticChatSpeechQueue: jest.fn(() => mockAutomatic),
    AgentTranscriptKind: { Claude: 0, Codex: 1, OpenCode: 2, Pi: 3 },
    ChatSpeechPart: {
      Text: part('Text'),
      Tool: part('Tool'),
      Notice: part('Notice'),
    },
    ChatSpeechQueue: jest.fn().mockImplementation(() => ({
      update: mockUpdate, readResponse: mockReadResponse, next: mockNext, nextWithSource: mockNextWithSource, uniffiDestroy: mockDestroy,
    })),
    chatSpeechResponseAvailable: (...args: unknown[]) => mockAvailable(...args),
  };
});

test('manual playback preserves Rust chunk identity and UTF-16 position', () => {
  const chunk = { messageId: 'reply', partId: 'text', startUtf16: 302, text: '你好 👋' };
  mockNextWithSource.mockReturnValueOnce(JSON.stringify(chunk)).mockReturnValueOnce(undefined);
  const queue = new NativeChatSpeechQueue();
  expect(queue.nextWithSource()).toEqual(chunk);
  expect(queue.nextWithSource()).toBeUndefined();
  queue.dispose();
});

test('global speech forwards transcript identity, tab name, readiness, and time to the bounded Rust queue', () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(123);
  try {
    const queue = new NativeAutomaticChatSpeechQueue();
    queue.update('transcript', 'pi', 'Debug', true, false, []);
    expect(mockAutomatic.update).toHaveBeenCalledWith('transcript', 3, 'Debug', true, false, [], 123n);
    mockAutomatic.next.mockReturnValue({ key: 'transcript', text: 'Debug tab: Hello' });
    expect(queue.next()).toEqual({ key: 'transcript', text: 'Debug tab: Hello' });
    expect(mockAutomatic.next).toHaveBeenCalledWith(123n);
    queue.dismissCurrent();
    expect(mockAutomatic.dismissCurrent).toHaveBeenCalledTimes(1);
    queue.remove('transcript');
    expect(mockAutomatic.remove).toHaveBeenCalledWith('transcript');
    queue.reset();
    expect(mockAutomatic.reset).toHaveBeenCalledTimes(1);
    queue.dispose();
    expect(mockAutomatic.uniffiDestroy).toHaveBeenCalledTimes(1);
  } finally {
    now.mockRestore();
  }
});

beforeEach(() => jest.clearAllMocks());

test('automatic and manual speech forward question tools and notices without tool output or reasoning', () => {
  const questions = [{
    header: 'Approach', question: 'Which approach?', multiple: false,
    options: [{ label: 'First', description: 'Quickest' }, { label: 'Second' }],
  }];
  const messages: NativeAgentTranscriptMessage[] = [{
    id: 'reply', role: 'assistant', diffs: [], parts: [
      { type: 'text', id: 'intro', text: 'Pick an approach.' },
      { type: 'reasoning', id: 'thinking', text: 'Private thought' },
      {
        type: 'tool', id: 'ask', callId: 'call', tool: 'functions.request_user_input',
        state: {
          status: 'running', input: { question_summary: 'Which approach?' },
          output: 'Internal output', error: 'Internal error',
          files: [], diagnostics: [], loaded: [], questions,
        },
      },
      { type: 'notice', id: 'notice', level: 'info', text: 'Question requested', questions },
    ],
  }];
  const expected = [{
    id: 'reply', assistant: true, completed: false,
    prose: [
      { tag: 'Text', inner: { id: 'intro', text: 'Pick an approach.' } },
      { tag: 'Tool', inner: { id: 'call', tool: 'functions.request_user_input', summary: 'Which approach?', questions } },
      { tag: 'Notice', inner: { id: 'notice', questions } },
    ],
  }];
  const queue = new NativeChatSpeechQueue();
  queue.update('claude', true, messages);
  expect(mockUpdate).toHaveBeenCalledWith(0, true, expected);
  mockReadResponse.mockReturnValue(true);
  expect(queue.readResponse('claude', messages)).toBe(true);
  expect(mockReadResponse).toHaveBeenCalledWith(0, expected);
  mockAvailable.mockReturnValue(true);
  expect(canReadChatResponse('claude', messages)).toBe(true);
  expect(mockAvailable).toHaveBeenCalledWith(0, expected);
  queue.dispose();
  expect(mockDestroy).toHaveBeenCalledTimes(1);
});

test('question speech keeps the call identity when a live tool becomes a completed item', () => {
  const queue = new NativeChatSpeechQueue();
  const questions = [{ question: 'Orange or apple?', multiple: false, options: [{ label: 'Orange' }, { label: 'Apple' }] }];
  for (const [id, status] of [['raw-tool:call-fruit', 'running'], ['call-fruit', 'completed']] as const) {
    queue.update('codex', true, [{
      id: 'reply', role: 'assistant', diffs: [], parts: [{
        type: 'tool', id, callId: 'call-fruit', tool: 'request_user_input_async',
        state: { status, input: {}, files: [], diagnostics: [], loaded: [], questions },
      }],
    }]);
  }
  const speechParts = mockUpdate.mock.calls.map(call => call[2][0].prose);
  expect(speechParts).toEqual([0, 1].map(() => [{
    tag: 'Tool', inner: { id: 'call-fruit', tool: 'request_user_input_async', summary: '', questions },
  }]));
  queue.dispose();
});
