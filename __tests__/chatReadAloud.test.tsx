import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useChatReadAloud } from '../src/hooks/useChatReadAloud';
import { readChatResponse, type ChatSpeechTarget } from '../src/services/chatSpeech';
import { setSpeechInputActive } from '../src/services/speechInputFocus';
import type { TranscriptMessage } from '../src/agentChat';

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
let renderer: ReactTestRenderer;
let control: ReturnType<typeof useChatReadAloud>;
const onError = jest.fn();
const stop = jest.fn();

function Harness({ selected = target, transcript = messages }: {
  selected?: ChatSpeechTarget | null;
  transcript?: TranscriptMessage[];
}) {
  control = useChatReadAloud(selected, transcript, onError);
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
  expect(control).toMatchObject({ reading: false, disabled: false });
  expect(readChatResponse).not.toHaveBeenCalled();
  act(() => control.toggle());
  expect(control.reading).toBe(true);
  expect(readChatResponse).toHaveBeenCalledWith(target, messages, expect.any(Function), onError);
  act(() => control.toggle());
  expect(stop).toHaveBeenCalledTimes(1);
  expect(control.reading).toBe(false);
  act(() => control.toggle());
  act(() => jest.mocked(readChatResponse).mock.calls[1][2]());
  expect(control.reading).toBe(false);
});

test.each(['leave', 'switch', 'dictate'] as const)('stops manual playback on %s', reason => {
  act(() => control.toggle());
  act(() => {
    if (reason === 'leave') renderer.update(<Harness selected={null} />);
    if (reason === 'switch') renderer.update(<Harness selected={{ ...target, bindingToken: 'next' }} />);
    if (reason === 'dictate') setSpeechInputActive(true);
  });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(control.reading).toBe(false);
  if (reason !== 'switch') expect(control.disabled).toBe(true);
});

test('disables reading when the transcript contains only a user prompt or tool output', () => {
  act(() => renderer.update(<Harness transcript={[
    { ...messages[0], role: 'user' },
    { ...messages[0], id: 'tool-only', parts: [] },
  ]} />));
  expect(control.disabled).toBe(true);
  act(() => control.toggle());
  expect(readChatResponse).not.toHaveBeenCalled();
});

test('reports unavailable speech without leaving the button active', () => {
  const error = new Error('No voice installed');
  jest.mocked(readChatResponse).mockImplementationOnce(() => { throw error; });
  act(() => control.toggle());
  expect(control.reading).toBe(false);
  expect(onError).toHaveBeenCalledWith(error);
});
