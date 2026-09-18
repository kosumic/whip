import { useImperativeHandle, type ComponentProps, type Ref } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import {
  Keyboard,
  Platform,
  type KeyboardEvent,
  type View,
} from 'react-native';

import { TerminalScreen } from '../src/components/TerminalScreen';
import { AgentChatView } from '../src/components/AgentChatView';
import { emptyTranscript } from '../src/agentChat';
import { terminalControlBarInset } from '../src/lib/floatingChrome';
import { setTerminalKeyboardOverlay } from '../src/services/terminalSoftInput';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  Modal: 'Modal',
  Image: 'Image',
  ActivityIndicator: 'ActivityIndicator',
  NativeModules: {},
  Platform: { OS: 'android' },
  StyleSheet: { absoluteFill: {}, create: (styles: unknown) => styles },
  AppState: { addEventListener: () => ({ remove: jest.fn() }) },
  Keyboard: {
    addListener: jest.fn(),
    metrics: jest.fn(),
    isVisible: jest.fn(),
    dismiss: jest.fn(),
  },
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'AnimatedView' },
  cancelAnimation: jest.fn(),
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: (callback: () => unknown) => callback(),
  withTiming: (value: number) => value,
}));
jest.mock('@rn-primitives/portal', () => ({ Portal: 'Portal' }));
jest.mock('@shopify/flash-list', () => ({ FlashList: 'FlashList' }));
jest.mock('react-native-code-highlighter', () => 'CodeHighlighter');
jest.mock('react-syntax-highlighter/dist/esm/styles/hljs', () => ({
  atomOneDarkReasonable: {},
  atomOneLight: {},
}));
jest.mock('../src/components/MarkdownText', () => ({ MarkdownText: 'MarkdownText' }));
jest.mock(
  'lucide-react-native',
  () => new Proxy({}, { get: (_target, name) => String(name) }),
);
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('../src/components/TerminalRendererHost', () => ({
  TerminalRendererHost: 'TerminalRendererHost',
}));
jest.mock('../src/components/MessageComposer', () => ({
  MessageComposer: MockMessageComposer,
  ComposerInput: 'ComposerInput',
}));
jest.mock('../src/components/GlassSurface', () => ({
  useAppGlassEnabled: () => false,
}));
jest.mock('../src/components/OverlayScrollbar', () => ({
  OverlayScrollbar: 'OverlayScrollbar',
}));
jest.mock('../src/components/AppAlertPopup', () => ({
  AppAlertPopup: 'AppAlertPopup',
}));
jest.mock('../src/components/app-ui', () => ({
  AnimatedAgentStatusGlyph: 'AgentGlyph',
  useReducedMotion: () => true,
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/theme', () => ({
  colors: {},
  useTheme: () => ({ colors: {} }),
  appGlassControlStyle: () => ({}),
}));
jest.mock('../src/services/volumeKeys', () => ({
  addTerminalVolumeKeyListener: () => ({ remove: jest.fn() }),
}));
jest.mock('../src/services/terminalSoftInput', () => ({
  setTerminalKeyboardOverlay: jest.fn(async () => {}),
}));
jest.mock('../src/services/operationalDiagnostics', () => ({
  recordOperationalDiagnostic: jest.fn(),
  operationalErrorDetails: () => ({}),
}));

const mockComposerHandle = { focus: jest.fn(), blur: jest.fn() };
function MockMessageComposer(composerProps: { inputRef: Ref<unknown> }) {
  useImperativeHandle(composerProps.inputRef, () => mockComposerHandle);
  return require('react/jsx-runtime').jsx('MessageComposer', composerProps);
}
const terminalHandle = {
  fit: jest.fn(),
  focus: jest.fn(),
  blur: jest.fn(),
  setKeyboardEnabled: jest.fn(),
  setForcedMouseInput: jest.fn(),
  clearSearch: jest.fn(),
  cancelPendingResumeScroll: jest.fn(),
};
const chatListHandle = { scrollToEnd: jest.fn(), scrollToOffset: jest.fn() };
const screenHeight = 800;
const keyboardHeight = 300;
const controlBarHeight = terminalControlBarInset(34);
const keyboardFrame = {
  screenX: 0,
  screenY: screenHeight - keyboardHeight,
  width: 400,
  height: keyboardHeight,
};
type Props = ComponentProps<typeof TerminalScreen>;
const target = {
  key: 'target-1',
  hostSessionId: 'host-1',
  client: {},
  session: {
    terminalId: 'terminal-1',
    title: 'Terminal',
    status: 'connected',
    reconnectAttempt: 0,
  },
} as Props['targets'][number];
const props: Props = {
  activeTarget: target,
  targets: [target],
  visible: true,
  compact: true,
  preferences: {
    fullscreen: true,
    useModifierKeyIcons: false,
    volumeUpAction: 'none',
    volumeDownAction: 'none',
    fontSize: 14,
    scrollback: 2000,
    xtermCacheCapacity: 4,
    cursorBlink: true,
    doubleTapAction: 'none',
    openLinksInApp: false,
    pauseResizeInBackground: false,
    visualHints: false,
    backgroundImageUri: null,
    backgroundDimming: 0,
  },
  controlUsage: {},
  historyEntries: [],
  chatViewEnabled: false,
  onControlUse: jest.fn(),
  onHistoryEntry: jest.fn(),
  getComposerDraft: () => '',
  onComposerDraftChange: jest.fn(),
  onFontSizeChange: jest.fn(),
  onClose: jest.fn(),
  onStatus: jest.fn(),
};

let renderer: ReactTestRenderer;
let listeners: Map<string, Set<(event: KeyboardEvent) => void>>;
const ui = (name: string) =>
  renderer.root.find(node => node.type === (name === 'MessageComposer' ? MockMessageComposer : name));
const button = (label: string) =>
  renderer.root.find(
    node =>
      String(node.type) === 'Button' &&
      node.props.accessibilityLabel === `terminal.${label}`,
  );

function emitKeyboard(visible: boolean) {
  jest
    .mocked(Keyboard.metrics)
    .mockReturnValue(visible ? keyboardFrame : undefined);
  jest.mocked(Keyboard.isVisible).mockReturnValue(visible);
  act(() => {
    for (const listener of listeners.get(
      visible ? 'keyboardDidShow' : 'keyboardDidHide',
    ) ?? []) {
      listener({
        duration: 0,
        easing: 'keyboard',
        endCoordinates: keyboardFrame,
      });
    }
  });
}

function mount(overrides: Partial<Props> = {}) {
  act(() => {
    renderer = create(<TerminalScreen {...props} {...overrides} />, {
      createNodeMock: element => {
        if (element.type === 'TerminalRendererHost') return terminalHandle;
        if (element.type === 'FlashList') return chatListHandle;
        if (element.type !== 'View') return null;
        const viewProps = element.props as ComponentProps<typeof View>;
        return {
          measureInWindow: (
            callback: Parameters<View['measureInWindow']>[0],
          ) => {
            const view = renderer.root.find(
              node =>
                String(node.type) === 'View' &&
                node.props.className === viewProps.className,
            );
            const translateY =
              view.props.style?.transform?.[0]?.translateY ?? 0;
            callback(0, translateY, 400, screenHeight);
          },
        };
      },
    });
  });
  act(() => {
    ui('TerminalRendererHost').props.onReady();
  });
  act(() => jest.advanceTimersByTime(100));
  terminalHandle.fit.mockClear();
}

async function press(label: string) {
  await act(async () => button(label).props.onPress());
}

// Check the rendered ancestors before dispatching callbacks: invoking a callback
// alone would still pass when a native pointerEvents boundary blocks the gesture.
function expectTouchEnabled(node: ReactTestInstance) {
  expect(node.props.pointerEvents).not.toBe('box-none');
  for (let ancestor: ReactTestInstance | null = node; ancestor; ancestor = ancestor.parent) {
    expect(ancestor.props.pointerEvents ?? 'auto').not.toBe('none');
    expect(ancestor.props.pointerEvents ?? 'auto').not.toBe('box-only');
  }
}

function scrollEvent(offset: number) {
  return { nativeEvent: {
    contentOffset: { y: offset },
    contentSize: { height: 1000 },
    layoutMeasurement: { height: 400 },
  } };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  listeners = new Map();
  jest.mocked(Keyboard.metrics).mockReturnValue(undefined);
  jest.mocked(Keyboard.isVisible).mockReturnValue(false);
  jest.mocked(Keyboard.addListener).mockImplementation((event, listener) => {
    const callbacks = listeners.get(event) ?? new Set();
    callbacks.add(listener);
    listeners.set(event, callbacks);
    return { remove: () => callbacks.delete(listener) } as unknown as ReturnType<
      typeof Keyboard.addListener
    >;
  });
});

afterEach(() => {
  act(() => renderer?.unmount());
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('Chat mode covers the terminal while the evicted transcript has no viewport yet', () => {
  mount();
  const onResidencyEnd = jest.fn();
  act(() => renderer.update(<TerminalScreen {...props} chatViewEnabled onResidencyEnd={onResidencyEnd} />));
  const background = renderer.root.find(node => node.props.className === 'absolute inset-0 z-10 bg-background');
  expect(background.props.accessibilityElementsHidden).toBe(true);
  expect(ui('TerminalRendererHost').props.onResidencyEnd).toBe(onResidencyEnd);
  act(() => renderer.update(<TerminalScreen {...props} />));
  expect(renderer.root.findAll(node => node.props.className === 'absolute inset-0 z-10 bg-background')).toHaveLength(0);
});

describe.each(['android', 'ios'] as const)(
  '%s terminal composer keyboard',
  platform => {
    beforeEach(() => {
      Platform.OS = platform;
    });

    test('chat stays touch-enabled and scrolls before, during, and after composing', async () => {
      mount({
        chatViewEnabled: true,
        renderViewportOverlay: (contentInsets, latestButtonBottom) => <AgentChatView
          agent="codex"
          agentStatus="idle"
          contentInsets={contentInsets}
          latestButtonBottom={latestButtonBottom}
          onOpenFile={jest.fn()}
          state={{ sessionId: 'chat-1', status: 'live', transcript: emptyTranscript('chat-1') }}
        />,
      });
      const list = ui('FlashList');
      act(() => {
        list.props.onLayout({ nativeEvent: { layout: { height: 400 } } });
        list.props.onContentSizeChange(400, 1000);
        list.props.onScroll(scrollEvent(600));
      });

      for (const composing of [false, true, false]) {
        if (composing) {
          await press('compose');
          emitKeyboard(true);
          const composer = ui('MessageComposer');
          expectTouchEnabled(composer);
          expect(composer.parent?.parent?.props.pointerEvents).toBe('box-none');
          expect(composer.props.showSoftInputOnFocus).toBe(true);
          expect(terminalHandle.setKeyboardEnabled).toHaveBeenLastCalledWith(false);
        } else if (renderer.root.findAllByType(MockMessageComposer).length) {
          await act(async () => ui('MessageComposer').props.actions.onClose());
          await act(async () => emitKeyboard(false));
        }

        expect(ui('FlashList')).toBe(list);
        expectTouchEnabled(list);
        act(() => {
          list.props.onScrollBeginDrag(scrollEvent(600));
          list.props.onScroll(scrollEvent(400));
          list.props.onScrollEndDrag(scrollEvent(400));
          list.props.onMomentumScrollBegin();
          list.props.onScroll(scrollEvent(300));
          list.props.onMomentumScrollEnd(scrollEvent(300));
        });
        const scrollbar = ui('OverlayScrollbar');
        expectTouchEnabled(scrollbar);
        act(() => {
          scrollbar.props.onDragStart({ trackHeight: 400, thumbHeight: 160 });
          scrollbar.props.onDrag({ dy: -40, trackHeight: 400, thumbHeight: 160 });
          scrollbar.props.onDragEnd();
        });
        expect(chatListHandle.scrollToOffset).toHaveBeenLastCalledWith({ offset: 200, animated: false });
        const latest = renderer.root.find(node => node.props.accessibilityLabel === 'Jump to latest');
        expectTouchEnabled(latest);
        act(() => { latest.props.onPress(); });
        expect(chatListHandle.scrollToEnd).toHaveBeenLastCalledWith({ animated: true });
        act(() => { list.props.onScroll(scrollEvent(600)); });
      }
    });

    test('terminal scrollback and scrollbar stay interactive while composer owns the keyboard', async () => {
      const scrollTerminal = jest.fn(async () => '');
      const scrollTarget = {
        ...target,
        client: { terminal: { scrollTerminal } },
        scroll: { offset_from_bottom: 0, max_offset_from_bottom: 100, viewport_rows: 24 },
      } as unknown as Props['targets'][number];
      mount({ activeTarget: scrollTarget, targets: [scrollTarget] });
      await press('enableKeyboard');
      await press('compose');
      emitKeyboard(true);
      act(() => jest.advanceTimersByTime(100));
      terminalHandle.focus.mockClear();
      mockComposerHandle.blur.mockClear();
      jest.mocked(Keyboard.dismiss).mockClear();

      const terminal = ui('TerminalRendererHost');
      expectTouchEnabled(terminal);
      const scrollbar = ui('OverlayScrollbar');
      expectTouchEnabled(scrollbar);
      const previousTop = scrollbar.props.topPercent;
      act(() => { terminal.props.onScroll(scrollTarget, 'up', 10); });
      expect(ui('OverlayScrollbar').props.topPercent).toBeLessThan(previousTop);
      act(() => {
        scrollbar.props.onDragStart({ trackHeight: 400, thumbHeight: 80 });
        scrollbar.props.onDrag({ dy: -32, trackHeight: 400, thumbHeight: 80 });
        scrollbar.props.onDragEnd();
      });
      expect(scrollTerminal).toHaveBeenCalledWith('terminal-1', 'up', 10);
      expect(terminalHandle.setKeyboardEnabled).toHaveBeenLastCalledWith(false);
      expect(terminalHandle.focus).not.toHaveBeenCalled();
      expect(mockComposerHandle.blur).not.toHaveBeenCalled();
      expect(Keyboard.dismiss).not.toHaveBeenCalled();
      expect(setTerminalKeyboardOverlay).toHaveBeenLastCalledWith('terminal-1', true);

      await act(async () => ui('MessageComposer').props.actions.onClose());
      await act(async () => emitKeyboard(false));
      expectTouchEnabled(terminal);
      expectTouchEnabled(ui('OverlayScrollbar'));
      expect(terminalHandle.setKeyboardEnabled).toHaveBeenLastCalledWith(true);
      expect(setTerminalKeyboardOverlay).toHaveBeenLastCalledWith('terminal-1', true);
    });

    test.each([false, true])(
      'opening over an already visible IME restores previous keyboard preference %s',
      async previouslyEnabled => {
        mount();
        if (previouslyEnabled) await press('enableKeyboard');
        // The IME may belong to another input while direct terminal input is disabled.
        emitKeyboard(true);
        const subscriptionCount = jest.mocked(Keyboard.addListener).mock.calls
          .length;
        await press('compose');

        const composer = ui('MessageComposer');
        expect(composer.parent?.props.style.bottom).toBe(
          controlBarHeight + keyboardHeight,
        );
        expect(composer.props.autoFocus).toBe(true);
        expect(composer.props.showSoftInputOnFocus).toBe(true);
        // Repeated native geometry must measure the viewport, not translated chrome.
        emitKeyboard(true);
        expect(ui('MessageComposer').parent?.props.style.bottom).toBe(
          controlBarHeight + keyboardHeight,
        );
        expect(ui('TerminalRendererHost').parent?.props.style).toBeUndefined();
        expect(Keyboard.addListener).toHaveBeenCalledTimes(subscriptionCount);
        expect(terminalHandle.setKeyboardEnabled).toHaveBeenLastCalledWith(
          false,
        );
        act(() => jest.advanceTimersByTime(40));
        expect(mockComposerHandle.focus).toHaveBeenCalledTimes(
          platform === 'ios' ? 0 : 1,
        );
        act(() => jest.advanceTimersByTime(60));
        expect(mockComposerHandle.focus).toHaveBeenCalledTimes(1);
        expect(terminalHandle.fit).not.toHaveBeenCalled();

        await act(async () => composer.props.actions.onClose());
        // Closing waits for the actual hide before removing the floating composer.
        expect(ui('MessageComposer').parent?.props.style.bottom).toBe(
          controlBarHeight + keyboardHeight,
        );
        await act(async () => emitKeyboard(false));
        expect(
          renderer.root.findAll(
            node => String(node.type) === 'MessageComposer',
          ),
        ).toHaveLength(0);
        expect(
          button(previouslyEnabled ? 'disableKeyboard' : 'enableKeyboard').props
            .accessibilityState.selected,
        ).toBe(previouslyEnabled);
        expect(terminalHandle.setKeyboardEnabled).toHaveBeenLastCalledWith(
          previouslyEnabled,
        );
      },
    );

    test('input toggles during show and hide keep composer geometry until the IME hides', async () => {
      mount();
      await press('compose');
      await press('disableKeyboard');
      emitKeyboard(true);
      expect(ui('MessageComposer').parent?.props.style.bottom).toBe(
        controlBarHeight + keyboardHeight,
      );
      await press('enableKeyboard');
      await press('disableKeyboard');
      expect(ui('MessageComposer').parent?.props.style.bottom).toBe(
        controlBarHeight + keyboardHeight,
      );
      emitKeyboard(false);
      expect(ui('MessageComposer').parent?.props.style.bottom).toBe(
        controlBarHeight,
      );
      act(() => jest.advanceTimersByTime(100));
      expect(terminalHandle.fit).not.toHaveBeenCalled();
    });

    test('the direct keyboard slides the same canvas until native hide completes without fitting', async () => {
      mount();
      const terminal = ui('TerminalRendererHost');
      expect(terminal.parent?.props.collapsable).toBe(false);
      await press('enableKeyboard');
      emitKeyboard(true);
      expect(ui('TerminalRendererHost').parent?.props.style).toEqual({
        transform: [{ translateY: -keyboardHeight }],
      });
      // Repeated show events measure the stationary outer viewport.
      emitKeyboard(true);
      expect(ui('TerminalRendererHost').parent?.props.style).toEqual({
        transform: [{ translateY: -keyboardHeight }],
      });
      act(() => jest.advanceTimersByTime(100));
      expect(terminalHandle.fit).not.toHaveBeenCalled();
      await press('disableKeyboard');
      expect(ui('TerminalRendererHost').parent?.props.style).toEqual({
        transform: [{ translateY: -keyboardHeight }],
      });
      emitKeyboard(false);
      expect(ui('TerminalRendererHost').parent?.props.style).toBeUndefined();
      act(() => jest.advanceTimersByTime(100));
      expect(ui('TerminalRendererHost')).toBe(terminal);
      expect(terminalHandle.fit).not.toHaveBeenCalled();
      expect(setTerminalKeyboardOverlay).toHaveBeenLastCalledWith('terminal-1', true);
      act(() => renderer.update(<TerminalScreen {...props} visible={false} />));
      expect(setTerminalKeyboardOverlay).toHaveBeenLastCalledWith('terminal-1', false);
    });
  },
);
