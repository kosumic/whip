import { createRef, useState } from 'react';
import { Modal } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { VoiceChatScreen, type VoiceChatHandle } from '../src/components/VoiceChatScreen';
import { VoiceConversation, type VoiceConversationView } from '../src/services/voiceConversation';
import type { ChatSpeechTarget } from '../src/services/chatSpeech';
import { VoiceVadSensitivityContext } from '../src/lib/voiceVadSensitivity';
import { useReducedMotion } from '../src/components/app-ui';
import { VoiceOrb } from '../src/components/VoiceOrb';
import { voiceSessionManager } from '../src/services/voiceSessionManager';
import { Text } from '../src/components/ui/text';

jest.mock('../src/services/voiceConversation', () => ({ VoiceConversation: jest.fn() }));
jest.mock('../src/services/voiceSessionManager', () => {
  const actual = jest.requireActual<typeof import('../src/services/voiceSessionManager')>('../src/services/voiceSessionManager');
  return { ...actual, voiceSessionManager: new actual.VoiceSessionManager(async (target, send, changed) => {
    const { VoiceConversation: Conversation } = jest.requireMock<typeof import('../src/services/voiceConversation')>('../src/services/voiceConversation');
    return new Conversation(target, send, changed);
  }) };
});
jest.mock('../src/components/VoiceOrb', () => ({ VoiceOrb: 'VoiceOrb' }));
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator', Modal: 'Modal', Pressable: 'Pressable', View: 'View', ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { cost?: string }) => key === 'voiceProvider.costEstimate' ? `Estimated voice total: ${values?.cost}` : key }) }));
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: { canvas: '#000', text: '#fff', primary: '#acf', onPrimary: '#000' } }) }));
jest.mock('../src/components/app-ui', () => ({ useReducedMotion: jest.fn(() => true) }));
jest.mock('../src/components/GlassSurface', () => ({ GlassPortal: 'GlassPortal' }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('react-native-svg', () => ({
  __esModule: true, default: 'Svg', Circle: 'Circle', Defs: 'Defs', FeGaussianBlur: 'FeGaussianBlur', Filter: 'Filter', LinearGradient: 'LinearGradient', Path: 'Path', RadialGradient: 'RadialGradient', Stop: 'Stop',
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'AnimatedView', createAnimatedComponent: (component: unknown) => component },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: (style: () => unknown) => style(),
  useAnimatedProps: (props: () => unknown) => props(),
  cancelAnimation: jest.fn(), withTiming: (value: number) => value, withRepeat: (value: number) => value,
  Easing: { cubic: 'cubic', inOut: (easing: unknown) => easing },
}));
jest.mock('lucide-react-native/icons/mic', () => 'Mic');
jest.mock('lucide-react-native/icons/plus', () => 'Plus');
jest.mock('lucide-react-native/icons/audio-lines', () => 'AudioLines');
jest.mock('lucide-react-native/icons/mic-off', () => 'MicOff');
jest.mock('lucide-react-native/icons/message-square', () => 'MessageSquare');
jest.mock('lucide-react-native/icons/chevron-down', () => 'ChevronDown');
jest.mock('lucide-react-native/icons/skip-forward', () => 'SkipForward');
jest.mock('lucide-react-native/icons/x', () => 'X');
jest.mock('lucide-react-native/icons/volume-2', () => 'Volume2');

const target: ChatSpeechTarget & { tabId: string } = { agent: 'codex', bindingToken: 'chat', hostId: 'host', paneId: 'pane', tabId: 'tab', label: 'Codex' };
const listening: VoiceConversationView = { phase: 'listening', muted: false, smartTurn: false, speaker: false, text: '', level: 0, progress: 0, error: null, transcript: null };
const session = { submitted: jest.fn(), start: jest.fn(() => Promise.resolve()), close: jest.fn(() => Promise.resolve()), toggleMuted: jest.fn(), toggleSpeaker: jest.fn(), skip: jest.fn(), finish: jest.fn(), install: jest.fn(), setVadSensitivity: jest.fn(), setTranscriptBinding: jest.fn() };
const controller = createRef<VoiceChatHandle>();
const onClose = jest.fn();
const onCompose = jest.fn();
const onAttach = jest.fn();
let publish: (view: VoiceConversationView) => void;
let renderer: ReactTestRenderer;

function Call({ visible = true }: { visible?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const [active, setActive] = useState(true);
  return active && <VoiceChatScreen ref={controller} target={target} send={() => true} visible={visible} expanded={expanded} dockStyle={{ bottom: 120 }}
    onMinimize={() => setExpanded(false)} onExpand={() => setExpanded(true)} onClose={() => { onClose(); setActive(false); }} onCompose={onCompose} onAttach={onAttach} />;
}

function press(label: string) {
  act(() => { renderer.root.findByProps({ accessibilityLabel: label }).props.onPress(); });
}

const renderedText = () => renderer.root.findAllByType(Text).map(node => node.props.children);

beforeEach(async () => {
  jest.clearAllMocks();
  jest.mocked(VoiceConversation).mockImplementation((_target, _send, changed) => {
    publish = changed;
    return session as unknown as VoiceConversation;
  });
  await act(async () => { renderer = create(<Call />); });
  act(() => publish(listening));
});
afterEach(async () => { await act(async () => { renderer.unmount(); await voiceSessionManager.hangup(); }); });

test('retains the streaming conversation when compacted and reopened', () => {
  const messages = [
    { id: 'user', role: 'user' as const, text: 'What is new?', active: false, spokenUtf16: 0 },
    { id: 'assistant', role: 'assistant' as const, text: 'Here is the latest answer.', active: true, spokenUtf16: 10 },
  ];
  act(() => publish({ ...listening, provider: 'openai', phase: 'speaking', messages }));
  expect(renderer.root.findByProps({ accessibilityLabel: messages[1].text }).props.numberOfLines).toBeUndefined();
  press('voiceChat.minimize');
  press('voiceChat.reopen');
  expect(renderer.root.findByProps({ accessibilityLabel: messages[1].text })).toBeDefined();
  expect(session.start).toHaveBeenCalledTimes(1);
  expect(session.close).not.toHaveBeenCalled();
});

test('shows native streaming positions without applying an additional Realtime offset', () => {
  const messages = [{ id: 'reply', role: 'assistant' as const, text: 'Hello, this is a reply.', active: true, spokenUtf16: 8 }];
  act(() => publish({ ...listening, phase: 'speaking', messages }));
  expect(renderedText()).toContain('this');
  act(() => publish({ ...listening, provider: 'openai', phase: 'speaking', messages }));
  expect(renderedText()).toContain('this');
  act(() => publish({ ...listening, provider: 'openai', phase: 'speaking', messages: [{ ...messages[0], spokenUtf16: 12 }] }));
  expect(renderedText()).toContain('is');
  expect(messages[0].spokenUtf16).toBe(8);
});

test('settings changes update the existing call without restarting it', () => {
  act(() => { renderer.update(<VoiceVadSensitivityContext value={75}><Call /></VoiceVadSensitivityContext>); });
  jest.clearAllMocks();
  act(() => { renderer.update(<VoiceVadSensitivityContext value={25}><Call /></VoiceVadSensitivityContext>); });
  expect(session.setVadSensitivity).toHaveBeenLastCalledWith(25);
  expect(session.start).not.toHaveBeenCalled();
  expect(session.close).not.toHaveBeenCalled();
});

test('a new agent receives its transcript binding without restarting voice chat', () => {
  const renderCall = (bindingToken?: string) => <VoiceChatScreen target={{ ...target, bindingToken }} send={() => true}
    visible expanded dockStyle={{}} onMinimize={() => {}} onExpand={() => {}} onClose={onClose} />;
  act(() => { renderer.update(renderCall()); });
  jest.clearAllMocks();
  act(() => { renderer.update(renderCall('first-transcript')); });
  expect(session.setTranscriptBinding).toHaveBeenLastCalledWith('first-transcript');
  expect(session.start).not.toHaveBeenCalled();
  expect(session.close).not.toHaveBeenCalled();
});

test('replacing a call cancels late prompts from its old session', async () => {
  const firstSend = jest.fn(() => true);
  const secondSend = jest.fn(() => true);
  const renderCall = (paneId: string, send: (text: string) => boolean) => <VoiceChatScreen target={{ ...target, paneId }} send={send}
    visible expanded dockStyle={{}} onMinimize={() => {}} onExpand={() => {}} onClose={onClose} />;
  await act(async () => renderer.update(renderCall('first-pane', firstSend)));
  const previousSend = jest.mocked(VoiceConversation).mock.calls.at(-1)![1];
  jest.clearAllMocks();
  await act(async () => renderer.update(renderCall('second-pane', secondSend)));
  expect(session.close).toHaveBeenCalledTimes(1);
  expect(session.start).toHaveBeenCalledTimes(1);
  previousSend('Late prompt from the first call');
  expect(firstSend).not.toHaveBeenCalled();
  expect(secondSend).not.toHaveBeenCalled();
  jest.mocked(VoiceConversation).mock.calls.at(-1)![1]('New prompt');
  expect(secondSend).toHaveBeenCalledWith('New prompt');
});

test.each(['voiceChat.minimize', 'voiceChat.transcript', 'back'])('%s returns to chat without hanging up; the orb reopens the same call', action => {
  const startedAt = renderer.root.findByType(VoiceOrb).props.startedAt;
  if (action === 'back') act(() => { renderer.root.findByType(Modal).props.onRequestClose(); });
  else press(action);

  expect(renderer.root.findByType(Modal).props.visible).toBe(false);
  expect(renderer.root.findByProps({ accessibilityLabel: 'voiceChat.reopen' })).toBeDefined();
  expect(renderer.root.findByType(VoiceOrb).props.startedAt).toBe(startedAt);
  expect(session.close).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();

  act(() => publish({ ...listening, phase: 'speaking' }));
  expect(renderer.root.findByProps({ accessibilityLabel: 'voiceChat.reopen' }).props.accessibilityHint).toBe('voiceChat.speaking');
  press('voiceChat.reopen');

  expect(renderer.root.findByType(Modal).props.visible).toBe(true);
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'voiceChat.reopen' })).toHaveLength(0);
  expect(renderer.root.findByType(VoiceOrb).props.startedAt).toBe(startedAt);
  expect(session.start).toHaveBeenCalledTimes(1);
  expect(session.close).not.toHaveBeenCalled();
});

test('minimizing finishes the orb transition before handing control back to chat', () => {
  jest.useFakeTimers();
  jest.mocked(useReducedMotion).mockReturnValue(false);
  try {
    act(() => renderer.update(<Call />));
    press('voiceChat.minimize');
    expect(renderer.root.findByType(Modal).props.visible).toBe(true);
    expect(session.close).not.toHaveBeenCalled();
    act(() => jest.runOnlyPendingTimers());
    expect(renderer.root.findByType(Modal).props.visible).toBe(false);
    expect(renderer.root.findByProps({ accessibilityLabel: 'voiceChat.reopen' })).toBeDefined();
    expect(session.start).toHaveBeenCalledTimes(1);
  } finally {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    jest.useRealTimers();
  }
});

test('hiding and restoring the host screen preserves the minimized call', () => {
  press('voiceChat.minimize');
  act(() => renderer.update(<Call visible={false} />));
  expect(renderer.root.findByType(Modal).props.visible).toBe(false);
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'voiceChat.reopen' })).toHaveLength(0);
  expect(session.close).not.toHaveBeenCalled();

  act(() => renderer.update(<Call />));
  expect(renderer.root.findByProps({ accessibilityLabel: 'voiceChat.reopen' })).toBeDefined();
  expect(session.start).toHaveBeenCalledTimes(1);
});

test.each([false, true])('the explicit hang-up control ends the call (minimized=%s)', minimized => {
  if (minimized) press('voiceChat.minimize');
  press('voiceChat.end');
  expect(session.close).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
});

test('the minimized composer can mute and unmute the ongoing call', () => {
  press('voiceChat.minimize');
  press('voiceChat.mute');
  expect(session.toggleMuted).toHaveBeenCalledTimes(1);
  act(() => publish({ ...listening, phase: 'muted', muted: true }));
  press('voiceChat.unmute');
  expect(session.toggleMuted).toHaveBeenCalledTimes(2);
  expect(session.start).toHaveBeenCalledTimes(1);
});

test.each(['voiceChat.compose', 'terminal.attach'])('%s returns to the existing composer while keeping the call active', action => {
  press(action);
  expect(renderer.root.findByType(Modal).props.visible).toBe(false);
  expect(action === 'voiceChat.compose' ? onCompose : onAttach).toHaveBeenCalledTimes(1);
  expect(session.close).not.toHaveBeenCalled();
});

test('a system hang-up removes the floating orb', () => {
  press('voiceChat.minimize');
  act(() => publish({ ...listening, phase: 'closed' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'voiceChat.reopen' })).toHaveLength(0);
});

 test('typing through the minimized call handle preserves the active conversation', () => {
  press('voiceChat.compose');
  act(() => { controller.current?.submitted('Typed follow-up'); });
  expect(session.submitted).toHaveBeenCalledWith('Typed follow-up');
  expect(session.start).toHaveBeenCalledTimes(1);
  expect(session.close).not.toHaveBeenCalled();
});

test('unmounting and remounting a presentation preserves the call and elapsed time', async () => {
  const startedAt = renderer.root.findByType(VoiceOrb).props.startedAt;
  act(() => renderer.unmount());
  expect(session.close).not.toHaveBeenCalled();
  await act(async () => { renderer = create(<Call />); });
  expect(session.start).toHaveBeenCalledTimes(1);
  expect(session.close).not.toHaveBeenCalled();
  expect(renderer.root.findByType(VoiceOrb).props.startedAt).toBe(startedAt);
  press('voiceChat.end');
  expect(session.close).toHaveBeenCalledTimes(1);
});

test('shows the current API voice estimate and no cost for non-API calls', () => {
  act(() => publish({ ...listening, estimatedUsd: 0.01234 }));
  expect(renderedText()).not.toContain('Estimated voice total: $0.0123');
  expect(renderedText()).not.toContain('voiceProvider.costUnknown');
  act(() => publish({ ...listening, provider: 'openai', estimatedUsd: 0.01234 }));
  expect(renderedText()).toContain('Estimated voice total: $0.0123');
  act(() => publish({ ...listening }));
  expect(renderedText()).not.toContain('Estimated voice total: $0.0123');
});

test('distinguishes unknown API costs from a reported zero estimate', () => {
  act(() => publish({ ...listening, provider: 'openai', estimatedUsd: null }));
  expect(renderedText()).not.toContain('voiceProvider.costUnknown');
  expect(renderedText()).not.toContain('Estimated voice total: $0.0000');
  act(() => publish({ ...listening, provider: 'openai', estimatedUsd: 0 }));
  expect(renderedText()).toContain('Estimated voice total: $0.0000');
});

test('retains the current API voice estimate when the chat presentation remounts', async () => {
  act(() => publish({ ...listening, provider: 'openai', estimatedUsd: 0.125 }));
  await act(async () => renderer.unmount());
  await act(async () => { renderer = create(<Call />); });
  expect(renderedText()).toContain('Estimated voice total: $0.1250');
  expect(session.start).toHaveBeenCalledTimes(1);
});

test('Live reports duration and keeps a public agent result visible when speech fails', () => {
  act(() => publish({ ...listening, provider: 'openai', liveSeconds: 15, estimatedUsd: 0.0125, backendText: 'The build passed. Inspect the agent chat for details.', phase: 'error', error: 'Voice delivery failed.' }));
  expect(renderedText()).toContain('The build passed. Inspect the agent chat for details.');
  expect(JSON.stringify(renderedText())).toContain('voiceUsage.remoteUnknown');
});
