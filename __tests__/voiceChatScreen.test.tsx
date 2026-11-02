import { useState } from 'react';
import { Modal } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { VoiceChatScreen } from '../src/components/VoiceChatScreen';
import { VoiceConversation, type VoiceConversationView } from '../src/services/voiceConversation';
import type { ChatSpeechTarget } from '../src/services/chatSpeech';
import { VoiceVadSensitivityContext } from '../src/lib/voiceVadSensitivity';

jest.mock('../src/services/voiceConversation', () => ({ VoiceConversation: jest.fn() }));
jest.mock('../src/components/VoiceOrb', () => ({ VoiceOrb: 'VoiceOrb' }));
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator', Modal: 'Modal', Pressable: 'Pressable', View: 'View',
  StyleSheet: { create: (styles: unknown) => styles },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: { canvas: '#000', text: '#fff', primary: '#acf', onPrimary: '#000' } }) }));
jest.mock('../src/components/app-ui', () => ({ useReducedMotion: () => true }));
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

const target: ChatSpeechTarget = { agent: 'codex', bindingToken: 'chat', hostId: 'host', paneId: 'pane', label: 'Codex' };
const listening: VoiceConversationView = { phase: 'listening', muted: false, smartTurn: false, speaker: false, text: '', level: 0, progress: 0, error: null, transcript: null };
const session = { start: jest.fn(), close: jest.fn(), toggleMuted: jest.fn(), toggleSpeaker: jest.fn(), skip: jest.fn(), finish: jest.fn(), install: jest.fn(), setVadSensitivity: jest.fn() };
const onClose = jest.fn();
const onCompose = jest.fn();
const onAttach = jest.fn();
let publish: (view: VoiceConversationView) => void;
let renderer: ReactTestRenderer;

function Call({ visible = true }: { visible?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const [active, setActive] = useState(true);
  return active && <VoiceChatScreen target={target} send={() => true} visible={visible} expanded={expanded} floatingStyle={{ bottom: 120 }}
    onMinimize={() => setExpanded(false)} onExpand={() => setExpanded(true)} onClose={() => { onClose(); setActive(false); }} onCompose={onCompose} onAttach={onAttach} />;
}

function press(label: string) {
  act(() => { renderer.root.findByProps({ accessibilityLabel: label }).props.onPress(); });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(VoiceConversation).mockImplementation((_target, _send, changed) => {
    publish = changed;
    return session as unknown as VoiceConversation;
  });
  act(() => { renderer = create(<Call />); });
  act(() => publish(listening));
});
afterEach(() => act(() => renderer.unmount()));

test('settings changes update the existing call without restarting it', () => {
  act(() => { renderer.update(<VoiceVadSensitivityContext value={75}><Call /></VoiceVadSensitivityContext>); });
  jest.clearAllMocks();
  act(() => { renderer.update(<VoiceVadSensitivityContext value={25}><Call /></VoiceVadSensitivityContext>); });
  expect(session.setVadSensitivity).toHaveBeenLastCalledWith(25);
  expect(session.start).not.toHaveBeenCalled();
  expect(session.close).not.toHaveBeenCalled();
});

test.each(['voiceChat.minimize', 'voiceChat.transcript', 'back'])('%s returns to chat without hanging up; the orb reopens the same call', action => {
  if (action === 'back') act(() => { renderer.root.findByType(Modal).props.onRequestClose(); });
  else press(action);

  expect(renderer.root.findByType(Modal).props.visible).toBe(false);
  expect(renderer.root.findByProps({ accessibilityLabel: 'voiceChat.reopen' })).toBeDefined();
  expect(session.close).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();

  act(() => publish({ ...listening, phase: 'speaking' }));
  expect(renderer.root.findByProps({ accessibilityLabel: 'voiceChat.reopen' }).props.accessibilityHint).toBe('voiceChat.speaking');
  press('voiceChat.reopen');

  expect(renderer.root.findByType(Modal).props.visible).toBe(true);
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'voiceChat.reopen' })).toHaveLength(0);
  expect(session.start).toHaveBeenCalledTimes(1);
  expect(session.close).not.toHaveBeenCalled();
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

test('the explicit hang-up control ends the call', () => {
  press('voiceChat.end');
  expect(session.close).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
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
