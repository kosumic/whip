import { useImperativeHandle, type ComponentProps, type Ref } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  Keyboard,
  Platform,
  type KeyboardEvent,
  type View,
} from 'react-native';

import { TerminalScreen } from '../src/components/TerminalScreen';
import { terminalControlBarInset } from '../src/lib/floatingChrome';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  Modal: 'Modal',
  Image: 'Image',
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
  setTerminalComposerOverlay: jest.fn(async () => {}),
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

function mount() {
  act(() => {
    renderer = create(<TerminalScreen {...props} />, {
      createNodeMock: element => {
        if (element.type === 'TerminalRendererHost') return terminalHandle;
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

describe.each(['android', 'ios'] as const)(
  '%s terminal composer keyboard',
  platform => {
    beforeEach(() => {
      Platform.OS = platform;
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
        if (platform === 'android')
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

    test('the direct keyboard reserves layout space until native hide completes', async () => {
      mount();
      await press('enableKeyboard');
      emitKeyboard(true);
      expect(ui('TerminalRendererHost').parent?.props.style).toEqual({
        paddingBottom: keyboardHeight,
      });
      act(() => jest.advanceTimersByTime(100));
      expect(terminalHandle.fit).toHaveBeenCalledTimes(
        platform === 'ios' ? 1 : 0,
      );
      await press('disableKeyboard');
      expect(ui('TerminalRendererHost').parent?.props.style).toEqual({
        paddingBottom: keyboardHeight,
      });
      emitKeyboard(false);
      expect(ui('TerminalRendererHost').parent?.props.style).toBeUndefined();
      act(() => jest.advanceTimersByTime(100));
      expect(terminalHandle.fit).toHaveBeenCalledTimes(
        platform === 'ios' ? 2 : 0,
      );
    });
  },
);
