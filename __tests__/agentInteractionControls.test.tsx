import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AgentInteractionControls, type AgentInteractionTarget } from '../src/components/AgentInteractionControls';
import type { NativeAgentInteractionPrompt } from 'react-native-whip-ssh';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', ScrollView: 'ScrollView', View: 'View' }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));

const PROMPT: NativeAgentInteractionPrompt = {
  token: 'live-prompt-1',
  text: 'Run this command?\n› 1. Yes, proceed\n2. No, tell the agent what to do differently',
  choices: [
    { label: 'Yes, proceed', index: 0, selected: true },
    { label: 'No, tell the agent what to do differently', index: 1, selected: false },
  ],
};
const readPrompt = jest.fn<Promise<NativeAgentInteractionPrompt | undefined>, [string, string]>();
const respond = jest.fn<Promise<void>, [string, string, string, string, string]>();
const TARGET: AgentInteractionTarget = {
  terminalId: 'terminal-1', bindingToken: 'binding-1',
  native: { agentInteractionPrompt: readPrompt, respondAgentInteraction: respond },
};
let renderer: ReactTestRenderer;

beforeEach(() => {
  jest.useFakeTimers();
  readPrompt.mockReset().mockResolvedValue(PROMPT);
  respond.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
  jest.useRealTimers();
});

async function mount(enabled = true, target = TARGET) {
  await act(async () => {
    renderer = create(<AgentInteractionControls target={target} enabled={enabled} />);
  });
}
function button(label: string) {
  return renderer.root.find(node => node.type === 'Button' as never && node.props.accessibilityLabel === label);
}

test('shows the live approval labels and selects before explicit confirmation', async () => {
  await mount();
  expect(readPrompt).toHaveBeenCalledWith('terminal-1', 'binding-1');
  await act(async () => { await button('Select No, tell the agent what to do differently').props.onPress(); });
  expect(respond).toHaveBeenLastCalledWith('terminal-1', 'binding-1', PROMPT.token, 'choice:1', '');
  expect(respond).toHaveBeenCalledTimes(1);
  await act(async () => { await button('Confirm agent selection').props.onPress(); });
  expect(respond).toHaveBeenLastCalledWith('terminal-1', 'binding-1', PROMPT.token, 'enter', '');
  expect(button('Confirm agent selection').props.disabled).toBe(true);
  await act(async () => { await button('Confirm agent selection').props.onPress(); });
  expect(respond).toHaveBeenCalledTimes(2);
});

test('sends a free text answer to the exact live session and clears it after success', async () => {
  await mount();
  const input = () => renderer.root.findByType('Input' as never);
  act(() => { input().props.onChangeText('Use SQLite'); });
  await act(async () => { await button('Send answer to agent').props.onPress(); });
  expect(respond).toHaveBeenCalledWith('terminal-1', 'binding-1', PROMPT.token, 'answer', 'Use SQLite');
  expect(input().props.value).toBe('');
});

test('hidden or stale chats have no controls and do not poll', async () => {
  await mount(false);
  expect(renderer.toJSON()).toBeNull();
  expect(readPrompt).not.toHaveBeenCalled();
  await act(async () => { jest.advanceTimersByTime(3600); });
  expect(readPrompt).not.toHaveBeenCalled();
});

test('a read from the previous binding cannot populate a replacement chat', async () => {
  let resolveOld!: (prompt: NativeAgentInteractionPrompt) => void;
  readPrompt.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  await mount();
  await act(async () => {
    renderer.update(<AgentInteractionControls target={{ ...TARGET, bindingToken: 'binding-2' }} enabled />);
  });
  await act(async () => { resolveOld({ ...PROMPT, token: 'obsolete', text: 'OLD QUESTION' }); });
  expect(JSON.stringify(renderer.toJSON())).not.toContain('OLD QUESTION');
  await act(async () => { await button('Confirm agent selection').props.onPress(); });
  expect(respond).toHaveBeenCalledWith('terminal-1', 'binding-2', PROMPT.token, 'enter', '');
});

test('pending responses cannot be double submitted and refreshed requests become usable', async () => {
  let resolveResponse!: () => void;
  respond.mockImplementationOnce(() => new Promise(resolve => { resolveResponse = resolve; }));
  await mount();
  act(() => {
    button('Confirm agent selection').props.onPress();
    button('Confirm agent selection').props.onPress();
  });
  expect(respond).toHaveBeenCalledTimes(1);
  readPrompt.mockResolvedValue({ ...PROMPT, token: 'live-prompt-2' });
  await act(async () => { resolveResponse(); });
  expect(button('Confirm agent selection').props.disabled).toBe(false);
});

test('connection errors remove actionable controls and offer a terminal fallback', async () => {
  readPrompt.mockRejectedValue(new Error('Host disconnected'));
  const openTerminal = jest.fn();
  await act(async () => {
    renderer = create(<AgentInteractionControls target={TARGET} enabled onOpenTerminal={openTerminal} />);
  });
  expect(renderer.root.findAll(node => node.props.accessibilityLabel === 'Confirm agent selection')).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).toContain('Host disconnected');
  act(() => { button('Answer in Terminal').props.onPress(); });
  expect(openTerminal).toHaveBeenCalledTimes(1);
});

test('a no longer pending prompt disappears even before the pane status catches up', async () => {
  readPrompt.mockResolvedValue(undefined);
  await mount();
  expect(renderer.toJSON()).toBeNull();
});

test('invalid answers retain the draft and allow correction without hiding the error', async () => {
  respond.mockRejectedValueOnce(Object.assign(new Error('Answers must be a single line.'), { code: 'InvalidField' }));
  await mount();
  const input = () => renderer.root.findByType('Input' as never);
  act(() => { input().props.onChangeText('one\ntwo'); });
  await act(async () => { await button('Send answer to agent').props.onPress(); });
  expect(input().props.value).toBe('one\ntwo');
  expect(button('Send answer to agent').props.disabled).toBe(false);
  expect(JSON.stringify(renderer.toJSON())).toContain('Answers must be a single line.');
});
