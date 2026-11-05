import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { VoiceHistoryRow } from '../src/components/VoiceHistoryRow';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  View: 'View', Pressable: 'Pressable',
  PanResponder: { create: (handlers: object) => ({ panHandlers: handlers }) },
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true, default: { View: 'AnimatedView' },
  useSharedValue: (value: number) => require('react').useRef({ value }).current,
  useAnimatedStyle: (fn: () => unknown) => fn(), withSpring: (value: number) => value, cancelAnimation: jest.fn(),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lucide-react-native/icons/x', () => 'X');
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/lib/motion', () => ({ DEFAULT_SPRING_CONFIG: {} }));

let renderer: ReactTestRenderer;
afterEach(() => act(() => renderer?.unmount()));

test('a full left swipe only reveals deletion and requires a separate button tap', async () => {
  const onOpen = jest.fn(), onDelete = jest.fn();
  await act(async () => { renderer = create(<VoiceHistoryRow onOpen={onOpen} onDelete={onDelete}>Call</VoiceHistoryRow>); });
  const row = () => renderer.root.find(node => typeof node.props.onPanResponderRelease === 'function');
  const action = () => renderer.root.findByProps({ accessibilityLabel: 'voiceUsage.deleteEntry' });
  expect(action().parent!.props.pointerEvents).toBe('none');
  expect(row().props.onMoveShouldSetPanResponderCapture({}, { dx: -100, dy: 5 })).toBe(true);
  expect(row().props.onMoveShouldSetPanResponderCapture({}, { dx: -5, dy: 100 })).toBe(false);
  await act(async () => row().props.onPanResponderRelease({}, { dx: -500, vx: -2 }));
  expect(onDelete).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
  expect(action().parent!.props.pointerEvents).toBe('auto');
  await act(async () => action().props.onPress());
  expect(onDelete).toHaveBeenCalledTimes(1);
});

test('tapping an open row closes actions before a later tap opens its transcript', async () => {
  const onOpen = jest.fn(), onDelete = jest.fn();
  await act(async () => { renderer = create(<VoiceHistoryRow onOpen={onOpen} onDelete={onDelete}>Call</VoiceHistoryRow>); });
  const body = () => renderer.root.findByProps({ accessibilityLabel: 'voiceUsage.openTranscript' });
  await act(async () => body().props.onAccessibilityAction({ nativeEvent: { actionName: 'showDelete' } }));
  await act(async () => body().props.onPress());
  expect(onOpen).not.toHaveBeenCalled();
  await act(async () => body().props.onPress());
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onDelete).not.toHaveBeenCalled();
});
