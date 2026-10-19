import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useChatReadAloud } from '../src/hooks/useChatReadAloud';
import { readChatResponse, type ChatSpeechTarget } from '../src/services/chatSpeech';
import { setSpeechInputActive } from '../src/services/speechInputFocus';
import type { TranscriptMessage, TranscriptTurn } from '../src/agentChat';

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('../src/services/chatSpeech', () => ({ readChatResponse: jest.fn() }));

const target: ChatSpeechTarget = {
  agent: 'claude', bindingToken: 'binding', hostId: 'host', paneId: 'pane', label: 'Claude',
};
const messages: TranscriptMessage[] = [{
  id: 'reply', role: 'assistant', completedAt: 1,
  diffs: [],
  parts: [{ id: 'text', type: 'text', text: 'Latest response' }],
}];
const turn: TranscriptTurn = { id: 'response', status: 'idle', assistants: messages, diffs: [] };
let renderer: ReactTestRenderer;
let control: ReturnType<typeof useChatReadAloud>;
const onError = jest.fn();
const stop = jest.fn();

function Harness({ selected = target }: {
  selected?: ChatSpeechTarget | null;
}) {
  control = useChatReadAloud(selected, onError);
  return null;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(readChatResponse).mockImplementation((_target, _messages, onStopped) => {
    stop.mockImplementation(onStopped);
    return stop;
  });
  act(() => { renderer = create(<Harness />); });
});
afterEach(() => {
  act(() => renderer.unmount());
  setSpeechInputActive(false);
});

test('reads on demand, switches to stop, and allows replay after completion', () => {
  expect(control.readingTurnId).toBeNull();
  expect(control.canRead(turn)).toBe(true);
  expect(readChatResponse).not.toHaveBeenCalled();
  act(() => control.toggle(turn));
  expect(control.readingTurnId).toBe(turn.id);
  expect(readChatResponse).toHaveBeenCalledWith(target, messages, expect.any(Function), onError);
  act(() => control.toggle(turn));
  expect(stop).toHaveBeenCalledTimes(1);
  expect(control.readingTurnId).toBeNull();
  act(() => control.toggle(turn));
  act(() => jest.mocked(readChatResponse).mock.calls[1][2]());
  expect(control.readingTurnId).toBeNull();
});

test('switches between responses and passes only the selected response messages to speech', () => {
  const older: TranscriptTurn = {
    ...turn, id: 'older-response',
    assistants: [{ ...messages[0], id: 'older-message', parts: [{ id: 'older-text', type: 'text', text: 'Older response' }] }],
  };
  act(() => control.toggle(turn));
  act(() => control.toggle(older));
  expect(stop).toHaveBeenCalledTimes(1);
  expect(control.readingTurnId).toBe(older.id);
  expect(jest.mocked(readChatResponse).mock.calls.map(call => call[1])).toEqual([turn.assistants, older.assistants]);
});

test.each(['leave', 'switch', 'dictate'] as const)('stops manual playback on %s', reason => {
  act(() => control.toggle(turn));
  act(() => {
    if (reason === 'leave') renderer.update(<Harness selected={null} />);
    if (reason === 'switch') renderer.update(<Harness selected={{ ...target, bindingToken: 'next' }} />);
    if (reason === 'dictate') setSpeechInputActive(true);
  });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(control.readingTurnId).toBeNull();
  if (reason !== 'switch') expect(control.canRead(turn)).toBe(false);
});

test('disables reading when the transcript contains only a user prompt or tool output', () => {
  const emptyResponse: TranscriptTurn = { ...turn, assistants: [
    { ...messages[0], role: 'user' },
    { ...messages[0], id: 'tool-only', parts: [] },
  ] };
  expect(control.canRead(emptyResponse)).toBe(false);
  act(() => control.toggle(emptyResponse));
  expect(readChatResponse).not.toHaveBeenCalled();
});

test('reports unavailable speech without leaving the button active', () => {
  const error = new Error('No voice installed');
  jest.mocked(readChatResponse).mockImplementationOnce(() => { throw error; });
  act(() => control.toggle(turn));
  expect(control.readingTurnId).toBeNull();
  expect(onError).toHaveBeenCalledWith(error);
});
