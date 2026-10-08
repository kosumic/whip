import { useImperativeHandle, type ComponentProps, type Ref } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import * as Haptics from 'expo-haptics';
import {
  Keyboard,
  Platform,
  type KeyboardEvent,
  type View,
} from 'react-native';

import { TerminalScreen } from '../src/components/TerminalScreen';
import { AgentChatView } from '../src/components/AgentChatView';
jest.mock('react-native-whip-ssh/src/chatSearch', () => ({
  NativeChatSearchIndex: jest.fn().mockImplementation(() => ({
    setDocuments: jest.fn(),
    search: jest.fn((query: string) => ({ query, matches: [], selected: undefined, truncated: false })),
    dispose: jest.fn(),
  })),
}));
import { emptyTranscript } from '../src/agentChat';
import {
  TERMINAL_CURSOR_CLEARANCE,
  terminalControlBarInset,
  terminalSessionChromeHeight,
} from '../src/lib/floatingChrome';
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
jest.mock('react-syntax-highlighter/dist/esm/default-highlight', () =>
  jest.requireActual('react-syntax-highlighter/dist/cjs/default-highlight'),
);
jest.mock('react-syntax-highlighter/dist/esm/styles/hljs', () => ({
  atomOneDarkReasonable: {},
  atomOneLight: {},
}));
jest.mock('../src/components/MarkdownText', () => ({ MarkdownText: 'MarkdownText' }));
jest.mock('../src/services/remoteFileTransfer', () => ({ cacheRemoteFile: jest.fn() }));
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
  latestButtonStyle: () => ({}),
}));
jest.mock('../src/services/volumeKeys', () => ({
  addTerminalVolumeKeyListener: (listener: (key: 'up' | 'down') => void) => {
    mockVolumeKeyListeners.add(listener);
    return { remove: () => mockVolumeKeyListeners.delete(listener) };
  },
}));
jest.mock('../src/services/terminalSoftInput', () => ({
  setTerminalKeyboardOverlay: jest.fn(async () => {}),
}));
jest.mock('../src/services/operationalDiagnostics', () => ({
  recordOperationalDiagnostic: jest.fn(),
  operationalErrorDetails: () => ({}),
}));

const mockComposerHandle = { focus: jest.fn(), blur: jest.fn(), clear: jest.fn() };
const mockVolumeKeyListeners = new Set<(key: 'up' | 'down') => void>();
function MockMessageComposer(composerProps: { inputRef: Ref<unknown> }) {
  useImperativeHandle(composerProps.inputRef, () => mockComposerHandle);
  return require('react/jsx-runtime').jsx('MessageComposer', composerProps);
}
const terminalHandle = {
  input: jest.fn(() => true),
  submitPastes: jest.fn(async () => undefined),
  fit: jest.fn(),
  focus: jest.fn(),
  blur: jest.fn(),
  setKeyboardEnabled: jest.fn(),
  setForcedMouseInput: jest.fn(),
  clearSearch: jest.fn(),
  search: jest.fn(),
  cancelPendingResumeScroll: jest.fn(),
  changeFontSize: jest.fn(),
  scroll: jest.fn(),
};
const chatListHandle = {
  scrollToEnd: jest.fn(),
  scrollToOffset: jest.fn(),
  getAbsoluteLastScrollOffset: jest.fn(() => 0),
};
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
  mockVolumeKeyListeners.clear();
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

test('volume keys use the latest terminal action and ignore hidden terminals', () => {
  const fontPreferences = { ...props.preferences, volumeUpAction: 'font-size' as const };
  const scrollPreferences = { ...props.preferences, volumeUpAction: 'scroll' as const };
  mount({ preferences: fontPreferences });

  act(() => { for (const listener of mockVolumeKeyListeners) listener('up'); });
  expect(terminalHandle.changeFontSize).toHaveBeenCalledWith(1);

  act(() => renderer.update(<TerminalScreen {...props} preferences={scrollPreferences} />));
  act(() => { for (const listener of mockVolumeKeyListeners) listener('up'); });
  expect(terminalHandle.scroll).toHaveBeenCalledWith('up', 1);
  expect(terminalHandle.changeFontSize).toHaveBeenCalledTimes(1);

  act(() => renderer.update(<TerminalScreen {...props} visible={false} preferences={scrollPreferences} />));
  act(() => { for (const listener of mockVolumeKeyListeners) listener('up'); });
  expect(terminalHandle.scroll).toHaveBeenCalledTimes(1);
});

test('terminal keys and modifier locking give selection feedback while composer typing stays quiet', async () => {
  mount();

  await press('upKey');
  expect(props.onControlUse).toHaveBeenLastCalledWith('up');
  expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);

  await press('ctrlModifier');
  expect(props.onControlUse).toHaveBeenLastCalledWith('ctrl');
  expect(Haptics.selectionAsync).toHaveBeenCalledTimes(2);

  act(() => { button('ctrlModifier').props.onLongPress(); });
  expect(Haptics.selectionAsync).toHaveBeenCalledTimes(3);

  await press('compose');
  act(() => { ui('MessageComposer').props.onChangeText('hello'); });
  expect(Haptics.selectionAsync).toHaveBeenCalledTimes(3);
});

test.each([false, true])('composer reports message acceptance in terminal and chat (chat=%s)', async chatViewEnabled => {
  mount({ chatViewEnabled });
  await press('compose');

  act(() => {
    expect(ui('MessageComposer').props.actions.onSend()).toBe(false);
  });
  act(() => { ui('MessageComposer').props.onChangeText('hello'); });
  await act(async () => {
    expect(ui('MessageComposer').props.actions.onSend()).toBe(true);
  });

  expect(terminalHandle.submitPastes).toHaveBeenCalledTimes(1);
  expect(props.onComposerDraftChange).toHaveBeenLastCalledWith('terminal-1', '');
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

test('terminal search shares four-result pages, direct selection, and stale-result handling', async () => {
  mount();
  await press('find');
  act(() => { ui('Input').props.onChangeText('needle'); });
  const matches = Array.from({ length: 6 }, (_, index) => ({ before: `${index} `, matched: 'needle', after: '', leading: false, trailing: false }));
  act(() => { ui('TerminalRendererHost').props.onSearchResult({ query: 'needle', caseSensitive: false, regex: false, matches, index: 0, invalid: false, truncated: false }); });
  const results = () => renderer.root.findAll(node => String(node.type) === 'Pressable' && node.props.accessibilityLabel?.startsWith('Result '));
  const searchButton = (label: string) => renderer.root.find(node => String(node.type) === 'Button' && node.props.accessibilityLabel === label);
  expect(results()).toHaveLength(4);
  act(() => { results()[2].props.onPress(); });
  expect(terminalHandle.search).toHaveBeenLastCalledWith('needle', false, false, 0, 2);
  act(() => { searchButton('Next results page').props.onPress(); });
  expect(terminalHandle.search).toHaveBeenLastCalledWith('needle', false, false, 0, 4);
  act(() => { ui('TerminalRendererHost').props.onSearchResult({ query: 'needle', caseSensitive: false, regex: false, matches, index: 4, invalid: false, truncated: false }); });
  expect(results()).toHaveLength(2);
  expect(results()[0].props.accessibilityLabel).toMatch(/^Result 5:/);
  act(() => { searchButton('Match case').props.onPress(); });
  expect(terminalHandle.search).toHaveBeenLastCalledWith('needle', true, false, 0);
  expect(results()).toHaveLength(0);
  expect(searchButton('Next match').props.disabled).toBe(true);
});

test.each(['opencode', 'codex', 'claude'] as const)('bottom rail Find searches %s chat and follows the visible view', async agent => {
  const state = { sessionId: 'chat-1', status: 'stale' as const, transcript: emptyTranscript('chat-1') };
  const renderChat: Props['renderViewportOverlay'] = (contentInsets, latestButtonBottom, search) => (
    <AgentChatView agent={agent} agentStatus="idle" state={state} contentInsets={contentInsets}
      latestButtonBottom={latestButtonBottom} searchOpen={search.open} onCloseSearch={search.onClose}
      onOpenFile={jest.fn()} />
  );
  mount({ chatViewEnabled: true, renderViewportOverlay: renderChat });
  expect(renderer.root.findAll(node => node.props.accessibilityLabel === 'Search conversation')).toHaveLength(0);
  await press('find');
  expect(ui('Input').props.accessibilityLabel).toBe('Search chat');
  expect(button('find').props.accessibilityState.selected).toBe(true);
  act(() => { ui('Input').props.onChangeText('needle'); });
  act(() => jest.advanceTimersByTime(200));
  expect(terminalHandle.search).not.toHaveBeenCalled();

  act(() => { renderer.root.find(node => String(node.type) === 'Button' && node.props.accessibilityLabel === 'Close search').props.onPress(); });
  expect(button('find').props.accessibilityState.selected).toBe(false);
  expect(renderer.root.findAll(node => String(node.type) === 'Input')).toHaveLength(0);
  await press('find');
  await press('find');
  expect(renderer.root.findAll(node => String(node.type) === 'Input')).toHaveLength(0);

  await press('find');
  act(() => renderer.update(<TerminalScreen {...props} renderViewportOverlay={renderChat} />));
  expect(button('find').props.accessibilityState.selected).toBe(false);
  expect(renderer.root.findAll(node => String(node.type) === 'Input')).toHaveLength(0);
  await press('find');
  expect(ui('Input').props.placeholder).toBe('Search terminal');
  act(() => { ui('Input').props.onChangeText('terminal needle'); });
  expect(terminalHandle.search).toHaveBeenLastCalledWith('terminal needle', false, false, 0);
  act(() => renderer.update(<TerminalScreen {...props} chatViewEnabled renderViewportOverlay={renderChat} />));
  expect(button('find').props.accessibilityState.selected).toBe(false);
  await press('find');
  expect(ui('Input').props.accessibilityLabel).toBe('Search chat');
  expect(ui('Input').props.value).toBe('');
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
      const chatRoot = renderer.root.findByProps({ testID: 'agent-chat-root' });
      expect(chatRoot.props.pointerEvents).toBe('none');
      act(() => {
        renderer.root.findByProps({ testID: 'agent-chat-viewport' }).props.onLayout({
          nativeEvent: { layout: { height: 400 } },
        });
        list.props.onLayout({ nativeEvent: { layout: { height: 400 } } });
        list.props.onContentSizeChange(400, 1000);
        list.props.onLoad();
      });
      expect(chatRoot.props.pointerEvents).toBe('none');
      act(() => {
        list.props.onScroll(scrollEvent(600));
      });
      expect(chatRoot.props.pointerEvents).toBe('auto');

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

    test.each([1, 2])('composer clears the %s-pane rail and reclaims its space while the keyboard is visible', async paneCount => {
      const sessionChromeInset = terminalSessionChromeHeight(paneCount);
      const onSessionChromeLayoutChange = jest.fn();
      const renderViewportOverlay = jest.fn(() => null);
      mount({ sessionChromeInset, onSessionChromeLayoutChange, renderViewportOverlay });
      await press('compose');
      await press('disableKeyboard');
      expect(ui('MessageComposer').parent?.props.style.bottom).toBe(
        controlBarHeight + sessionChromeInset,
      );
      emitKeyboard(true);
      expect(ui('MessageComposer').parent?.props.style.bottom).toBe(
        controlBarHeight + keyboardHeight,
      );
      expect(onSessionChromeLayoutChange).toHaveBeenLastCalledWith({
        bottom: controlBarHeight + keyboardHeight, visible: false,
      });
      await press('enableKeyboard');
      await press('disableKeyboard');
      expect(ui('MessageComposer').parent?.props.style.bottom).toBe(
        controlBarHeight + keyboardHeight,
      );

      const measuredControlHeight = controlBarHeight + 8;
      const measuredComposerHeight = 102;
      act(() => {
        renderer.root.findByProps({ className: 'absolute inset-x-0 bottom-0 z-30' })
          .props.onLayout({ nativeEvent: { layout: { height: measuredControlHeight } } });
        ui('MessageComposer').parent?.props.onLayout({
          nativeEvent: { layout: { height: measuredComposerHeight } },
        });
      });
      expect(ui('MessageComposer').parent?.props.style.bottom).toBe(
        measuredControlHeight + keyboardHeight,
      );
      expect(onSessionChromeLayoutChange).toHaveBeenLastCalledWith({
        bottom: measuredControlHeight + keyboardHeight, visible: false,
      });
      expect(renderViewportOverlay).toHaveBeenLastCalledWith(
        { top: 0, bottom: measuredControlHeight + keyboardHeight + measuredComposerHeight },
        expect.any(Number),
        expect.any(Object),
      );

      emitKeyboard(false);
      expect(ui('MessageComposer').parent?.props.style.bottom).toBe(
        measuredControlHeight + sessionChromeInset,
      );
      expect(onSessionChromeLayoutChange).toHaveBeenLastCalledWith({
        bottom: measuredControlHeight, visible: true,
      });
      act(() => jest.advanceTimersByTime(100));
      expect(terminalHandle.fit).not.toHaveBeenCalled();
    });

    test('the direct keyboard shifts the canvas to keep the reported cursor visible without fitting', async () => {
      mount();
      const terminal = ui('TerminalRendererHost');
      expect(terminal.parent?.props.collapsable).toBe(false);
      await press('enableKeyboard');
      emitKeyboard(true);
      expect(ui('TerminalRendererHost').parent?.props.style).toBeUndefined();
      const cursorBottom = 700;
      act(() => { void ui('TerminalRendererHost').props.onCursorGeometry(target, cursorBottom, screenHeight); });
      const cursorShift = cursorBottom + TERMINAL_CURSOR_CLEARANCE
        - (screenHeight - keyboardHeight - controlBarHeight);
      expect(ui('TerminalRendererHost').parent?.props.style).toEqual({
        transform: [{ translateY: -cursorShift }],
      });
      // Repeated show events measure the stationary outer viewport.
      emitKeyboard(true);
      expect(ui('TerminalRendererHost').parent?.props.style).toEqual({
        transform: [{ translateY: -cursorShift }],
      });
      act(() => jest.advanceTimersByTime(100));
      expect(terminalHandle.fit).not.toHaveBeenCalled();
      await press('disableKeyboard');
      expect(ui('TerminalRendererHost').parent?.props.style).toEqual({
        transform: [{ translateY: -cursorShift }],
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

test('diff questions append to the draft and open the composer without pasting into the terminal', () => {
  const consumed = jest.fn();
  const request = { id: 101, terminalId: target.session.terminalId, text: 'Please explain this diff:\n-old\n+new' };
  const overrides = { getComposerDraft: () => 'Existing question', composerDraftRequest: request, onComposerDraftConsumed: consumed };
  mount(overrides);
  expect(ui('MessageComposer').props.initialValue).toBe(`Existing question\n\n${request.text}`);
  expect(props.onComposerDraftChange).toHaveBeenCalledWith(target.session.terminalId, `Existing question\n\n${request.text}`);
  expect(consumed).toHaveBeenCalledWith(request.id);
  expect(props.onHistoryEntry).not.toHaveBeenCalled();
  act(() => renderer.update(<TerminalScreen {...props} {...overrides} composerDraftRequest={{ ...request }} />));
  expect(consumed).toHaveBeenCalledTimes(1);
  expect(props.onComposerDraftChange).toHaveBeenCalledTimes(1);
});

test('diff draft requests wait for the originating terminal', () => {
  const consumed = jest.fn();
  mount({ composerDraftRequest: { id: 102, terminalId: 'another-terminal', text: 'private diff' }, onComposerDraftConsumed: consumed });
  expect(renderer.root.findAllByType(MockMessageComposer)).toHaveLength(0);
  expect(props.onComposerDraftChange).not.toHaveBeenCalled();
  expect(consumed).not.toHaveBeenCalled();
});
