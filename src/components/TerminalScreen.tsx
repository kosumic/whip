import {
  forwardRef,
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Portal } from '@rn-primitives/portal';
import {
  ArrowBigUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowRightToLine,
  ArrowUp,
  BookOpen,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  CornerDownLeft,
  FolderOpen,
  Globe2,
  History,
  Keyboard as KeyboardIcon,
  MessageCircle,
  Minimize2,
  MousePointer2,
  Option,
  Paperclip,
  Search,
  Send,
  SquareTerminal,
  TriangleAlert,
  Undo2,
  X,
  type LucideIcon,
} from 'lucide-react-native';
import {
  AppState,
  Image,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type TextInput as TextInputHandle,
} from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { useKeyboardInset } from '@/src/hooks/useKeyboardInset';
import {
  contentInsetsWithSessionChrome,
  shouldShowTerminalSessionChrome,
  terminalInsetsWithTopPull,
  terminalControlBarInset,
  terminalLatestButtonBottom,
  terminalViewportLayout,
  type VisualContentInsets,
} from '@/src/lib/floatingChrome';
import { shouldDisplayLatencyWarning } from '@/src/lib/latencyWarning';
import { cn } from '@/src/lib/utils';
import { retryDelay } from '../lib/retryDelay';
import {
  claimTerminalMouseWarning,
  orderTerminalControls,
  swapTerminalArrowControls,
  terminalArrowControlCanSwap,
  terminalControlIsVisible,
  TERMINAL_CONTROL_HIT_SLOP,
  TERMINAL_ICON_CONTROL_CLASS,
  TERMINAL_TEXT_CONTROL_CLASS,
  type TerminalControlId,
  type TerminalControlUsage,
} from '../lib/terminalControls';
import { OfflineTerminalBackend } from '../lib/offlineTerminalBackend';
import {
  directTerminalKeyboardEnabled,
  terminalLatestButtonVisible,
  terminalScrollbackMode,
  type TerminalRenderTarget,
} from '../lib/terminalRenderer';
import type { TerminalProtocolState } from '../lib/terminalBridge';
import type { TerminalPreferences } from '../services/devicePreferences';
import {
  beginTerminalInputTrace,
  endTerminalWriteTrace,
  withTerminalWriteTrace,
} from '../services/performanceTrace';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import Clipboard from '@react-native-clipboard/clipboard';
import { setTerminalComposerOverlay } from '../services/terminalSoftInput';
import {
  applyTerminalModifiers,
  type TerminalModifierState,
} from '../lib/terminalInput';
import {
  moveTerminalScroll,
  scrollOffsetFromDrag,
  terminalScrollThumb,
} from '../lib/terminalScroll';
import { composeTerminalSubmission } from '../lib/terminalSubmission';
import { terminalSerializedTranscript } from '../lib/terminalTranscript';
import {
  resolveTerminalVolumeKeyAction,
  type TerminalVolumeKey,
} from '../lib/volumeKeys';
import { addTerminalVolumeKeyListener } from '../services/volumeKeys';
import { terminalFontFamily } from '../lib/terminalFonts';
import type { TerminalSessionStatus } from '../terminalSessions';
import { appGlassControlStyle, colors, useTheme } from '../theme';
import {
  TerminalRendererHost,
  type TerminalRendererHandle,
} from './TerminalRendererHost';
import { ComposerInput, MessageComposer } from './MessageComposer';
import { useAppGlassEnabled } from './GlassSurface';
import {
  OverlayScrollbar,
  type OverlayScrollbarDragEvent,
} from './OverlayScrollbar';
import { AnimatedAgentStatusGlyph, useReducedMotion } from './app-ui';
import { AppAlertPopup } from './AppAlertPopup';
import { Button, type ButtonProps } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Text } from './ui/text';

const TERMINAL_INPUT_CONTEXT = 'terminal-input-send';

interface Props {
  activeTarget: TerminalRenderTarget | null;
  targets: readonly TerminalRenderTarget[];
  visible: boolean;
  preferences: TerminalPreferences;
  controlUsage: TerminalControlUsage;
  historyEntries: readonly string[];
  compact?: boolean;
  sessionChromeInset?: number;
  onSessionChromeVisibilityChange?: (visible: boolean) => void;
  latencyMs?: number | null;
  latencyWarningActive?: boolean;
  onControlUse: (control: TerminalControlId) => void;
  onHistoryEntry: (entry: string) => void;
  getComposerDraft: (terminalId: string) => string;
  onComposerDraftChange: (terminalId: string, value: string) => void;
  onComposerQueueChange?: (
    terminalId: string,
    messages: readonly TerminalComposerQueueItem[],
  ) => void;
  linkScanRequest?: number;
  pasteRequest?: {
    id: number;
    text: string;
    previewUri?: string | null;
    dispose?: () => void;
  };
  onRequestAttachment?: () => void;
  onRequestFiles?: () => void;
  onRequestLinks?: () => void;
  chatControl?: {
    accessibilityLabel: string;
    active: boolean;
    disabled: boolean;
    loading: boolean;
    onPress: () => void;
  };
  chatViewEnabled: boolean;
  renderViewportOverlay?: (
    insets: VisualContentInsets,
    latestButtonBottom: number,
  ) => ReactNode;
  viewportOverlayBackground?: ReactNode;
  onOpenLink?: (link: string) => void;
  onLinksScanned?: (links: string[]) => void;
  onInteraction?: (target: TerminalRenderTarget) => void;
  onFontSizeChange: (target: TerminalRenderTarget, fontSize: number) => void;
  onClose: () => void;
  onStatus: (
    target: TerminalRenderTarget,
    status: TerminalSessionStatus,
    error?: string,
    reconnectAttempt?: number,
  ) => void;
}

export interface TerminalComposerQueueItem {
  id: number;
  historyEntry: string;
  sending: boolean;
  error: string | null;
}

export interface TerminalScreenHandle {
  enqueueComposerMessage: (
    text: string,
    attachmentPaths: readonly string[],
  ) => boolean;
}

type TerminalKeyDefinition = readonly [
  label: string,
  input: string,
  face: 'text' | 'symbol',
];

const ENTER_INPUT = '\r';
const TERMINAL_FIT_DEFER_MS = 40;
const TERMINAL_FOCUS_DEFER_MS = 40;
const COMPOSER_FOCUS_DEFER_MS = 40;
const IOS_COMPOSER_FOCUS_DEFER_MS = 100;
const COMPOSER_COLLAPSE_FOCUS_DEFER_MS = 80;
const TERMINAL_CONTROL_LONG_PRESS_MS = 450;

const TERMINAL_KEYS: Partial<Record<TerminalControlId, TerminalKeyDefinition>> =
  {
    esc: ['ESC', '\u001b', 'text'],
    tab: ['TAB', '\t', 'text'],
    up: ['↑', '\u001b[A', 'symbol'],
    left: ['←', '\u001b[D', 'symbol'],
    right: ['→', '\u001b[C', 'symbol'],
    down: ['↓', '\u001b[B', 'symbol'],
    enter: ['ENTER', ENTER_INPUT, 'text'],
    slash: ['/', '/', 'symbol'],
    pipe: ['|', '|', 'symbol'],
    tilde: ['~', '~', 'symbol'],
    end: ['END', '\u001b[F', 'text'],
    'page-up': ['PG↑', '\u001b[5~', 'text'],
    'page-down': ['PG↓', '\u001b[6~', 'text'],
    home: ['HOME', '\u001b[H', 'text'],
  };

interface TerminalIconDefinition {
  accessibilityKey: string;
  icon?: LucideIcon;
  label?: string;
}

const TERMINAL_KEY_ICONS: Partial<
  Record<TerminalControlId, TerminalIconDefinition>
> = {
  up: { icon: ArrowUp, accessibilityKey: 'terminal.upKey' },
  left: { icon: ArrowLeft, accessibilityKey: 'terminal.leftKey' },
  right: { icon: ArrowRight, accessibilityKey: 'terminal.rightKey' },
  down: { icon: ArrowDown, accessibilityKey: 'terminal.downKey' },
};

const ICONIC_TERMINAL_KEYS: Partial<
  Record<TerminalControlId, TerminalIconDefinition>
> = {
  esc: { label: '⎋', accessibilityKey: 'terminal.escapeKey' },
  tab: { icon: ArrowRightToLine, accessibilityKey: 'terminal.tabKey' },
  enter: { icon: CornerDownLeft, accessibilityKey: 'terminal.enterKey' },
};

const WEBVIEW_STYLE = { flex: 1, backgroundColor: 'transparent' } as const;
const BACKGROUND_SCREEN_STYLE = { mixBlendMode: 'screen' } as const;
const TERMINAL_ICON_BOX_CLASS = 'size-5 items-center justify-center';
const TERMINAL_ICON_SIZE = 18;
const TERMINAL_CONTROL_LABEL_STYLE = {
  includeFontPadding: false,
  textAlignVertical: 'center',
} as const;

interface TerminalScrollbarDragSnapshot {
  target: TerminalRenderTarget;
  startOffset: number;
  maxOffset: number;
  lastOffset: number;
  thumbHeight: number;
  trackHeight: number;
}

export function TerminalBackground({
  preferences,
}: {
  preferences: TerminalPreferences;
}) {
  if (!preferences.backgroundImageUri) return null;

  return (
    <View
      accessibilityElementsHidden
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, BACKGROUND_SCREEN_STYLE]}
    >
      <Image
        resizeMode="cover"
        source={{ uri: preferences.backgroundImageUri }}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: `rgba(0,0,0,${
              preferences.backgroundDimming / 100
            })`,
          },
        ]}
      />
    </View>
  );
}

function TerminalLatencyWarning({
  latencyMs,
  top,
  visible,
}: {
  latencyMs: number | null;
  top: number;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(visible ? 1 : 0);

  useEffect(() => {
    cancelAnimation(progress);
    progress.value = withTiming(visible ? 1 : 0, {
      duration: reduceMotion ? 0 : 120,
    });
    return () => cancelAnimation(progress);
  }, [progress, reduceMotion, visible]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * -4 }],
  }));
  const value = latencyMs ?? 0;

  return (
    <Animated.View
      accessibilityElementsHidden={!visible}
      accessibilityLabel={t('terminal.highLatencyA11y', { value })}
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      accessible={visible}
      importantForAccessibility={visible ? 'yes' : 'no-hide-descendants'}
      pointerEvents="none"
      className="absolute inset-x-0 z-20 h-9 flex-row items-center gap-2 border-b border-terminal-warning/60 bg-terminal-panel/95 px-3"
      style={[{ top }, animatedStyle]}
    >
      <TriangleAlert color={colors.warning} size={15} strokeWidth={2.25} />
      <Text
        numberOfLines={1}
        className="flex-1 text-[11px] font-semibold text-terminal-warning"
      >
        {t('terminal.highLatency')}
      </Text>
      <Text className="font-mono text-[11px] font-semibold text-terminal-warning">
        {value} ms
      </Text>
    </Animated.View>
  );
}

function useTerminalModifierState() {
  const [value, setValue] = useState<TerminalModifierState>('off');
  const valueRef = useRef<TerminalModifierState>('off');
  const update = useCallback(
    (
      next:
        | TerminalModifierState
        | ((current: TerminalModifierState) => TerminalModifierState),
    ) => {
      const resolved =
        typeof next === 'function' ? next(valueRef.current) : next;
      valueRef.current = resolved;
      setValue(resolved);
    },
    [],
  );
  return [value, valueRef, update] as const;
}

export const TerminalScreen = forwardRef<TerminalScreenHandle, Props>(
  function TerminalScreenComponent(
    {
      activeTarget,
      targets,
      visible,
      preferences,
      controlUsage,
      historyEntries,
      compact = false,
      sessionChromeInset = 0,
      onSessionChromeVisibilityChange,
      latencyMs = null,
      latencyWarningActive = false,
      onControlUse,
      onHistoryEntry,
      getComposerDraft,
      onComposerDraftChange,
      onComposerQueueChange,
      linkScanRequest = 0,
      pasteRequest,
      onRequestAttachment,
      onRequestFiles,
      onRequestLinks,
      chatControl,
      chatViewEnabled,
      renderViewportOverlay,
      viewportOverlayBackground,
      onOpenLink,
      onLinksScanned,
      onInteraction,
      onFontSizeChange,
      onClose,
      onStatus,
    }: Props,
    ref,
  ) {
    const { colors: appColors } = useTheme();
    const appGlassEnabled = useAppGlassEnabled();
    const { t } = useTranslation();
    const { bottom: bottomSafeAreaInset, top: topSafeAreaInset } =
      useSafeAreaInsets();
    const session = activeTarget?.session || null;
    const terminalId = session?.terminalId || '';
    const sessionTitle = session?.title || '';
    const status = session?.status || 'connecting';
    const renderer = useRef<TerminalRendererHandle | null>(null);
    const activeTargetRef = useRef(activeTarget);
    const keyboardViewportRef = useRef<View | null>(null);
    const handledPasteRequest = useRef(0);
    const composeAttachmentsByTargetRef = useRef(
      new Map<string, ComposeAttachment[]>(),
    );
    const composeAttachmentsRef = useRef<ComposeAttachment[]>([]);
    const queuedMessagesByTargetRef = useRef(
      new Map<string, QueuedComposerMessage[]>(),
    );
    const queuedMessageSequenceRef = useRef(0);
    const queueFlushesRef = useRef(new Set<string>());
    const queueRetryTimersRef = useRef(
      new Map<string, ReturnType<typeof setTimeout>>(),
    );
    const offlineBackendRef = useRef(new OfflineTerminalBackend());
    const flushQueuedTargetRef = useRef<(target: TerminalRenderTarget) => void>(
      () => {},
    );
    const enqueueComposerMessageRef = useRef<
      (text: string, attachmentPaths: readonly string[]) => boolean
    >(() => false);
    const targetsRef = useRef(targets);
    const composeInputRef = useRef<TextInputHandle | null>(null);
    const composeTextRef = useRef('');
    const keyboardEnabledBeforeComposeRef = useRef<boolean | null>(null);
    const terminalLayoutKeyboardInsetRef = useRef(0);
    const wasVisible = useRef(visible);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [ctrl, ctrlRef, setCtrl] = useTerminalModifierState();
    const [shift, shiftRef, setShift] = useTerminalModifierState();
    const [alt, altRef, setAlt] = useTerminalModifierState();
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchCase, setSearchCase] = useState(false);
    const [searchRegex, setSearchRegex] = useState(false);
    const [searchResult, setSearchResult] = useState({
      count: 0,
      index: -1,
      invalid: false,
    });
    const [composeOpen, setComposeOpen] = useState(false);
    const composeOpenRef = useRef(composeOpen);
    const [composeExpanded, setComposeExpanded] = useState(false);
    const [composerHeight, setComposerHeight] = useState(0);
    const [controlBarHeight, setControlBarHeight] = useState(
      terminalControlBarInset(bottomSafeAreaInset),
    );
    const [composeText, setComposeText] = useState('');
    const [composeAttachments, setComposeAttachments] = useState<
      ComposeAttachment[]
    >([]);
    const [queuedMessages, setQueuedMessages] = useState<
      QueuedComposerMessage[]
    >([]);
    const [, setOfflineBackendRevision] = useState(0);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [keyboardEnabled, setKeyboardEnabled] = useState(false);
    const [forcedMouseInput, setForcedMouseInput] = useState(false);
    const [forcedMouseInputWarningOpen, setForcedMouseInputWarningOpen] =
      useState(false);
    const [keyboardVisible, setKeyboardVisible] = useState(false);
    // Track the IME even while terminal input is disabled or focus is transferring.
    // Measure the unshifted viewport, since the controls move by this inset.
    const { inset: keyboardInset } = useKeyboardInset(keyboardViewportRef, {
      onVisibilityChange: setKeyboardVisible,
    });
    const [alternateScreen, setAlternateScreen] = useState(false);
    const [reportedTitle, setReportedTitle] = useState('');
    const [protocolState, setProtocolState] = useState<TerminalProtocolState>({
      kittyKeyboardReportAll: false,
    });
    const [scrollPosition, setScrollPosition] = useState(activeTarget?.scroll);
    const [visualBottomByTarget, setVisualBottomByTarget] = useState<
      Partial<Record<string, boolean>>
    >({});
    const scrollPositionRef = useRef(scrollPosition);
    const terminalScrollbarDragRef =
      useRef<TerminalScrollbarDragSnapshot | null>(null);
    const pendingTerminalScrollRef = useRef<{
      targetKey: string;
      scroll: TerminalRenderTarget['scroll'];
    } | null>(null);
    const [controlOrder, setControlOrder] = useState(() =>
      orderTerminalControls(controlUsage),
    );
    const scrollThumb = alternateScreen
      ? null
      : terminalScrollThumb(scrollPosition);
    const atVisualBottom = activeTarget
      ? visualBottomByTarget[activeTarget.key] ?? false
      : false;
    const title = reportedTitle || sessionTitle;
    const directKeyboardEnabled = directTerminalKeyboardEnabled(
      status,
      keyboardEnabled,
      composeOpen,
    );
    const composerKeyboardEnabled = composeOpen && keyboardEnabled;
    const keyboardControlDisabled = status !== 'connected' && !composeOpen;
    const keyboardControlSelected = keyboardEnabled && !keyboardControlDisabled;
    const sessionChromeVisible = shouldShowTerminalSessionChrome({
      composerVisible: composeOpen,
      keyboardEnabled,
      keyboardVisible,
    });
    composeOpenRef.current = composeOpen;
    const viewportLayout = useMemo(
      () =>
        terminalViewportLayout({
          composerExpanded: composeExpanded,
          composerHeight,
          composerVisible: composeOpen,
          controlBarHeight,
          keyboardInset,
          topInset: 0,
        }),
      [
        composeExpanded,
        composeOpen,
        composerHeight,
        controlBarHeight,
        keyboardInset,
      ],
    );
    const terminalLayoutKeyboardInset = viewportLayout.layoutKeyboardInset;
    const terminalScrollingInsets = useMemo(
      () => contentInsetsWithSessionChrome({
        insets: viewportLayout.terminalInsets,
        sessionChromeInset,
        sessionChromeVisible,
      }),
      [sessionChromeInset, sessionChromeVisible, viewportLayout.terminalInsets],
    );
    // The overlay remains edge-to-edge. Chat View uses this clearance for its
    // end spacer, so manually scrolled rows can still pass beneath the chrome.
    const viewportOverlayInsets = useMemo(
      () => contentInsetsWithSessionChrome({
        insets: viewportLayout.overlayInsets,
        sessionChromeInset,
        sessionChromeVisible,
      }),
      [sessionChromeInset, sessionChromeVisible, viewportLayout.overlayInsets],
    );
    const terminalVisualInsets = useMemo(
      () =>
        terminalInsetsWithTopPull(terminalScrollingInsets, sessionChromeInset),
      [sessionChromeInset, terminalScrollingInsets],
    );
    const terminalVisualViewport = useMemo(
      () => ({
        // Keep the renderer pullable below the top edge at the beginning of
        // scrollback without adding false occlusion to chat or the scrollbar.
        insets: terminalVisualInsets,
        // Floating controls overlay a genuinely full-screen xterm. Their measured
        // height is only a visual boundary allowance and never fitted geometry.
        geometryBottomInset: 0,
        alternateScreen,
        scroll: scrollPosition,
      }),
      [alternateScreen, scrollPosition, terminalVisualInsets],
    );
    const terminalLatestButtonOffset = terminalLatestButtonBottom({
      sessionChromeInset,
      sessionChromeVisible,
      terminalBottomInset: controlBarHeight,
    });
    const viewportLatestButtonBottom = terminalLatestButtonBottom({
      sessionChromeInset,
      sessionChromeVisible,
      terminalBottomInset: viewportLayout.overlayInsets.bottom,
    });
    const viewportOverlay = renderViewportOverlay?.(
      viewportOverlayInsets,
      viewportLatestButtonBottom,
    );
    activeTargetRef.current = activeTarget;
    scrollPositionRef.current = scrollPosition;
    targetsRef.current = targets;

    useEffect(() => {
      onSessionChromeVisibilityChange?.(sessionChromeVisible);
    }, [onSessionChromeVisibilityChange, sessionChromeVisible]);

    const restoreKeyboardAfterCompose = useCallback(() => {
      const previouslyEnabled = keyboardEnabledBeforeComposeRef.current;
      if (previouslyEnabled === null) return;
      keyboardEnabledBeforeComposeRef.current = null;
      setKeyboardEnabled(previouslyEnabled);
      if (!previouslyEnabled) {
        renderer.current?.setKeyboardEnabled(false);
        renderer.current?.blur();
        Keyboard.dismiss();
      }
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        enqueueComposerMessage: (text, attachmentPaths) =>
          enqueueComposerMessageRef.current(text, attachmentPaths),
      }),
      [],
    );

    useEffect(() => {
      const nextComposeText = terminalId ? getComposerDraft(terminalId) : '';
      const nextComposeAttachments = activeTarget?.key
        ? composeAttachmentsByTargetRef.current.get(activeTarget.key) || []
        : [];
      composeTextRef.current = nextComposeText;
      setComposeText(nextComposeText);
      composeAttachmentsRef.current = nextComposeAttachments;
      setComposeAttachments(nextComposeAttachments);
      setQueuedMessages(
        activeTarget?.key
          ? queuedMessagesByTargetRef.current.get(activeTarget.key) || []
          : [],
      );
      setError(null);
      setSearchOpen(false);
      setComposeOpen(false);
      restoreKeyboardAfterCompose();
      setComposeExpanded(false);
      setAlternateScreen(false);
      setReportedTitle('');
      setProtocolState({ kittyKeyboardReportAll: false });
      setHistoryOpen(false);
      setCtrl('off');
      setShift('off');
      setAlt('off');
    }, [
      activeTarget?.key,
      getComposerDraft,
      restoreKeyboardAfterCompose,
      setAlt,
      setCtrl,
      setShift,
      terminalId,
    ]);

    useEffect(() => {
      setForcedMouseInput(false);
      renderer.current?.setForcedMouseInput(false);
    }, [activeTarget?.key, status]);

    useEffect(() => {
      if (!keyboardEnabled || !forcedMouseInput) return;
      renderer.current?.setForcedMouseInput(false);
      setForcedMouseInput(false);
    }, [forcedMouseInput, keyboardEnabled]);

    const cacheTargetKey = activeTarget?.key || '';
    const offlineSnapshot = offlineBackendRef.current.snapshot(cacheTargetKey);

    useEffect(() => {
      offlineBackendRef.current.retain(
        new Set(targets.map(target => target.key)),
      );
    }, [targets]);

    const activeUsesOfflineScroll = Boolean(
      activeTarget &&
        activeTarget.session.kind !== 'ssh' &&
        terminalScrollbackMode(activeTarget.session).offlineScrollback,
    );
    const activeTargetKey = activeTarget?.key || '';
    const activeRemoteScroll = activeTarget?.scroll;
    useEffect(() => {
      const nextScroll =
        activeUsesOfflineScroll && activeTargetKey
          ? offlineBackendRef.current.snapshot(activeTargetKey).scroll
          : activeRemoteScroll;
      if (terminalScrollbarDragRef.current?.target.key === activeTargetKey) {
        pendingTerminalScrollRef.current = {
          targetKey: activeTargetKey,
          scroll: nextScroll,
        };
        return;
      }
      pendingTerminalScrollRef.current = null;
      scrollPositionRef.current = nextScroll;
      setScrollPosition(nextScroll);
    }, [activeRemoteScroll, activeTargetKey, activeUsesOfflineScroll]);

    useEffect(() => {
      terminalScrollbarDragRef.current = null;
      pendingTerminalScrollRef.current = null;
    }, [activeTargetKey]);

    const requestTerminalScrollOffset = (
      target: TerminalRenderTarget,
      previousOffset: number,
      desiredOffset: number,
    ) => {
      const lineDifference = desiredOffset - previousOffset;
      const active = activeTargetRef.current;
      if (target.key !== active?.key) return;
      renderer.current?.cancelPendingResumeScroll();
      if (lineDifference === 0) return;

      const current = scrollPositionRef.current;
      if (!current) return;
      const nextScroll = { ...current, offset_from_bottom: desiredOffset };
      scrollPositionRef.current = nextScroll;
      setScrollPosition(nextScroll);

      const direction = lineDifference > 0 ? 'up' : 'down';
      const lines = Math.abs(lineDifference);
      if (active.session.status === 'connected') {
        active.client.terminal
          .scrollTerminal(active.session.terminalId, direction, lines)
          .catch(reason => {
            if (active.key === activeTargetRef.current?.key)
              setError(String(reason));
          });
      } else {
        renderer.current?.scroll(direction, lines);
      }
    };

    const beginTerminalScrollbarDrag = ({
      trackHeight,
      thumbHeight,
    }: Omit<OverlayScrollbarDragEvent, 'dy'>) => {
      const target = activeTargetRef.current;
      const current = scrollPositionRef.current;
      if (!target || !current || trackHeight <= thumbHeight) {
        terminalScrollbarDragRef.current = null;
        return;
      }
      terminalScrollbarDragRef.current = {
        target,
        startOffset: current.offset_from_bottom,
        maxOffset: current.max_offset_from_bottom,
        lastOffset: current.offset_from_bottom,
        thumbHeight,
        trackHeight,
      };
    };

    const dragTerminalScrollbar = ({ dy }: OverlayScrollbarDragEvent) => {
      const drag = terminalScrollbarDragRef.current;
      if (!drag) return;
      const desiredOffset = scrollOffsetFromDrag({
        startOffset: drag.startOffset,
        dragDistance: dy,
        maxOffset: drag.maxOffset,
        trackHeight: drag.trackHeight,
        thumbHeight: drag.thumbHeight,
        direction: -1,
        step: 1,
      });
      if (desiredOffset === drag.lastOffset) return;
      const previousOffset = drag.lastOffset;
      drag.lastOffset = desiredOffset;
      requestTerminalScrollOffset(drag.target, previousOffset, desiredOffset);
    };

    const adjustTerminalScrollbar = (direction: 'up' | 'down') => {
      const target = activeTargetRef.current;
      const current = scrollPositionRef.current;
      if (!target || !current) return;
      const amount = Math.max(1, Math.round(current.viewport_rows));
      const desiredOffset = Math.max(
        0,
        Math.min(
          current.max_offset_from_bottom,
          current.offset_from_bottom + (direction === 'up' ? amount : -amount),
        ),
      );
      requestTerminalScrollOffset(
        target,
        current.offset_from_bottom,
        desiredOffset,
      );
    };

    const jumpTerminalToLatest = () => {
      renderer.current?.scrollToVisualBottom();
    };

    const finishTerminalScrollbarDrag = () => {
      terminalScrollbarDragRef.current = null;
      const correction = pendingTerminalScrollRef.current;
      pendingTerminalScrollRef.current = null;
      if (!correction || correction.targetKey !== activeTargetRef.current?.key)
        return;
      scrollPositionRef.current = correction.scroll;
      setScrollPosition(correction.scroll);
    };

    const writeInput = async (
      data: string,
      target: TerminalRenderTarget | null = activeTargetRef.current,
      refocusTerminal = true,
    ): Promise<boolean> => {
      if (!target) return false;
      if (target.session.status !== 'connected') {
        return target.key === activeTargetRef.current?.key
          ? Boolean(renderer.current?.input(data))
          : false;
      }
      const inputTrace = beginTerminalInputTrace(
        target.key,
        data.includes('\r') || data.includes('\n') ? 'submit' : 'input',
      );
      onInteraction?.(target);
      setScrollPosition(current =>
        current ? { ...current, offset_from_bottom: 0 } : current,
      );
      try {
        await withTerminalWriteTrace(inputTrace, () =>
          inputTrace
            ? target.client.terminal.writeToTerminal(
                target.session.terminalId,
                data,
                inputTrace,
              )
            : target.client.terminal.writeToTerminal(target.session.terminalId, data),
        );
        if (target.key === activeTargetRef.current?.key) setError(null);
        if (
          refocusTerminal &&
          target.key === activeTargetRef.current?.key &&
          keyboardEnabled &&
          keyboardVisible
        ) {
          renderer.current?.focus();
        }
        return true;
      } catch (reason) {
        endTerminalWriteTrace(inputTrace, false);
        if (target.key === activeTargetRef.current?.key)
          setError(String(reason));
        return false;
      }
    };

    const sendInput = async (
      data: string,
      target: TerminalRenderTarget | null = activeTargetRef.current,
      fromRenderer = false,
    ) => {
      if (!target) return false;
      if (
        !fromRenderer &&
        target.key === activeTargetRef.current?.key &&
        renderer.current?.input(data)
      )
        return true;
      if (target.key !== activeTargetRef.current?.key)
        return writeInput(data, target, false);
      const value = applyTerminalModifiers(
        data,
        ctrlRef.current,
        altRef.current,
        shiftRef.current,
        protocolState.kittyKeyboardReportAll,
      );
      if (ctrlRef.current === 'armed') setCtrl('off');
      if (shiftRef.current === 'armed') setShift('off');
      if (altRef.current === 'armed') setAlt('off');
      return writeInput(value, target);
    };

    const handleVolumeKey = useEffectEvent((key: TerminalVolumeKey) => {
      if (!visible || !session) return;
      const configured =
        key === 'up'
          ? preferences.volumeUpAction
          : preferences.volumeDownAction;
      const action = resolveTerminalVolumeKeyAction(configured, key);
      if (!action || action.type === 'terminal-tab') return;
      if (action.type === 'font-size') {
        renderer.current?.changeFontSize(action.delta);
      } else if (action.type === 'scroll') {
        renderer.current?.scroll(action.direction, 1);
      } else {
        reportBackgroundFailure(sendInput(action.data), TERMINAL_INPUT_CONTEXT);
      }
    });

    useEffect(() => {
      const subscription = addTerminalVolumeKeyListener(handleVolumeKey);
      return () => subscription.remove();
    }, []);

    useEffect(() => {
      if (!ready) {
        wasVisible.current = visible;
        return;
      }
      if (!visible) {
        if (wasVisible.current) renderer.current?.blur();
        wasVisible.current = false;
        return;
      }
      const enteredVisibility = !wasVisible.current;
      wasVisible.current = true;
      if (enteredVisibility && terminalId) {
        const nextComposeText = getComposerDraft(terminalId);
        if (nextComposeText !== composeTextRef.current) {
          composeTextRef.current = nextComposeText;
          setComposeText(nextComposeText);
          composeInputRef.current?.setNativeProps({ text: nextComposeText });
          composeInputRef.current?.setSelection(
            nextComposeText.length,
            nextComposeText.length,
          );
        }
      }
      if (enteredVisibility && !composeOpenRef.current) {
        renderer.current?.blur();
        Keyboard.dismiss();
      }
      const timer = setTimeout(() => {
        renderer.current?.fit();
      }, TERMINAL_FIT_DEFER_MS);
      return () => clearTimeout(timer);
    }, [getComposerDraft, ready, terminalId, visible]);

    useEffect(() => {
      if (status === 'connected' || composeOpen || !keyboardEnabled) return;
      setKeyboardEnabled(false);
      renderer.current?.setKeyboardEnabled(false);
      renderer.current?.blur();
      Keyboard.dismiss();
    }, [composeOpen, keyboardEnabled, status]);

    useEffect(() => {
      if (!ready) return;
      renderer.current?.setKeyboardEnabled(directKeyboardEnabled);
      if (!directKeyboardEnabled && !composerKeyboardEnabled) {
        Keyboard.dismiss();
      }
    }, [
      activeTarget?.key,
      composerKeyboardEnabled,
      directKeyboardEnabled,
      ready,
    ]);

    useEffect(() => {
      const dismissFocusedInput = () => {
        renderer.current?.blur();
        composeInputRef.current?.blur();
        Keyboard.dismiss();
      };
      const subscription = AppState.addEventListener(
        'change',
        dismissFocusedInput,
      );
      return () => subscription.remove();
    }, []);

    useEffect(() => {
      if (!linkScanRequest || !ready || !visible) return;
      renderer.current?.scanLinks();
    }, [linkScanRequest, ready, visible]);

    useEffect(() => {
      if (
        !pasteRequest ||
        !ready ||
        !visible ||
        pasteRequest.id <= handledPasteRequest.current
      )
        return;
      handledPasteRequest.current = pasteRequest.id;
      // Attachment requests always include previewUri; null identifies a
      // non-image attachment that must still remain a distinct paste event.
      if (composeOpen && pasteRequest.previewUri !== undefined) {
        const attachment = {
          id: pasteRequest.id,
          remotePath: pasteRequest.text,
          previewUri: pasteRequest.previewUri || null,
          dispose: pasteRequest.dispose || (() => {}),
        };
        composeAttachmentsRef.current = [
          ...composeAttachmentsRef.current,
          attachment,
        ];
        if (activeTargetRef.current) {
          composeAttachmentsByTargetRef.current.set(
            activeTargetRef.current.key,
            composeAttachmentsRef.current,
          );
        }
        setComposeAttachments(composeAttachmentsRef.current);
        return;
      }
      if (composeOpen) {
        const current = composeTextRef.current;
        const next = `${current}${current && !/\s$/.test(current) ? ' ' : ''}${
          pasteRequest.text
        }`;
        composeTextRef.current = next;
        setComposeText(next);
        onComposerDraftChange(terminalId, next);
        composeInputRef.current?.setNativeProps({ text: next });
        composeInputRef.current?.setSelection(next.length, next.length);
        pasteRequest.dispose?.();
        return;
      }
      renderer.current?.paste(pasteRequest.text);
      onHistoryEntry(pasteRequest.text);
      pasteRequest.dispose?.();
    }, [
      composeOpen,
      onComposerDraftChange,
      onHistoryEntry,
      pasteRequest,
      ready,
      terminalId,
      visible,
    ]);

    const publishQueuedMessages = useCallback(
      (targetKey: string, messages: QueuedComposerMessage[]) => {
        if (messages.length)
          queuedMessagesByTargetRef.current.set(targetKey, messages);
        else queuedMessagesByTargetRef.current.delete(targetKey);
        if (activeTargetRef.current?.key === targetKey)
          setQueuedMessages(messages);
        const target = targetsRef.current.find(item => item.key === targetKey);
        if (target) {
          onComposerQueueChange?.(
            target.session.terminalId,
            messages.map(
              ({ id, historyEntry, sending, error: queueError }) => ({
                id,
                historyEntry,
                sending,
                error: queueError,
              }),
            ),
          );
        }
      },
      [onComposerQueueChange],
    );

    const scheduleQueuedRetry = useCallback(
      (targetKey: string, attempts: number) => {
        if (queueRetryTimersRef.current.has(targetKey)) return;
        const delayMs = retryDelay(attempts);
        const timer = setTimeout(() => {
          queueRetryTimersRef.current.delete(targetKey);
          const target = targetsRef.current.find(
            item => item.key === targetKey,
          );
          if (target) flushQueuedTargetRef.current(target);
        }, delayMs);
        queueRetryTimersRef.current.set(targetKey, timer);
      },
      [],
    );

    const flushQueuedTarget = useCallback(
      async (target: TerminalRenderTarget) => {
        const targetKey = target.key;
        if (
          target.session.status !== 'connected' ||
          queueFlushesRef.current.has(targetKey)
        )
          return;
        const terminalRenderer = renderer.current;
        if (!terminalRenderer) return;
        const retryTimer = queueRetryTimersRef.current.get(targetKey);
        if (retryTimer) clearTimeout(retryTimer);
        queueRetryTimersRef.current.delete(targetKey);
        queueFlushesRef.current.add(targetKey);
        try {
          while (true) {
            const message =
              queuedMessagesByTargetRef.current.get(targetKey)?.[0];
            if (!message) return;
            const sendingMessage = { ...message, sending: true, error: null };
            const sendingQueue = [
              sendingMessage,
              ...(queuedMessagesByTargetRef.current.get(targetKey)?.slice(1) ||
                []),
            ];
            publishQueuedMessages(targetKey, sendingQueue);
            try {
              await terminalRenderer.submitPastes(
                target,
                message.pasteEvents,
                message.attempts === 0,
              );
              if (target.key === activeTargetRef.current?.key) setError(null);
            } catch (reason) {
              const current =
                queuedMessagesByTargetRef.current.get(targetKey) || [];
              const failed = current.map(item =>
                item.id === message.id
                  ? {
                      ...item,
                      sending: false,
                      attempts: item.attempts + 1,
                      error: String(reason),
                    }
                  : item,
              );
              publishQueuedMessages(targetKey, failed);
              scheduleQueuedRetry(targetKey, message.attempts + 1);
              return;
            }
            const current =
              queuedMessagesByTargetRef.current.get(targetKey) || [];
            if (current.some(item => item.id === message.id)) {
              publishQueuedMessages(
                targetKey,
                current.filter(item => item.id !== message.id),
              );
              for (const attachment of message.attachments)
                attachment.dispose();
              onHistoryEntry(message.historyEntry);
            }
          }
        } finally {
          queueFlushesRef.current.delete(targetKey);
        }
      },
      [onHistoryEntry, publishQueuedMessages, scheduleQueuedRetry],
    );
    flushQueuedTargetRef.current = target => {
      reportBackgroundFailure(
        flushQueuedTarget(target),
        'terminal-queue-flush',
      );
    };

    useEffect(() => {
      for (const target of targets) {
        if (
          target.session.status === 'connected' &&
          queuedMessagesByTargetRef.current.has(target.key)
        ) {
          flushQueuedTargetRef.current(target);
        }
      }
    }, [targets]);

    useEffect(
      () => () => {
        for (const attachments of composeAttachmentsByTargetRef.current.values()) {
          for (const attachment of attachments) attachment.dispose();
        }
        composeAttachmentsByTargetRef.current.clear();
        for (const messages of queuedMessagesByTargetRef.current.values()) {
          for (const message of messages) {
            for (const attachment of message.attachments) attachment.dispose();
          }
        }
        queuedMessagesByTargetRef.current.clear();
        for (const timer of queueRetryTimersRef.current.values())
          clearTimeout(timer);
        queueRetryTimersRef.current.clear();
        composeAttachmentsRef.current = [];
      },
      [],
    );

    useEffect(() => {
      const targetKeys = new Set(targets.map(target => target.key));
      for (const [key, attachments] of composeAttachmentsByTargetRef.current) {
        if (targetKeys.has(key)) continue;
        for (const attachment of attachments) attachment.dispose();
        composeAttachmentsByTargetRef.current.delete(key);
      }
      for (const [key, messages] of queuedMessagesByTargetRef.current) {
        if (targetKeys.has(key)) continue;
        for (const message of messages) {
          for (const attachment of message.attachments) attachment.dispose();
        }
        queuedMessagesByTargetRef.current.delete(key);
        const timer = queueRetryTimersRef.current.get(key);
        if (timer) clearTimeout(timer);
        queueRetryTimersRef.current.delete(key);
      }
    }, [targets]);

    useEffect(() => {
      if (!visible) {
        if (composeOpen) {
          setComposeOpen(false);
          restoreKeyboardAfterCompose();
        }
        setComposeExpanded(false);
        setHistoryOpen(false);
      }
      reportBackgroundFailure(
        setTerminalComposerOverlay(terminalId, visible && composeOpen),
        'terminal-composer-overlay-sync',
      );
    }, [composeOpen, restoreKeyboardAfterCompose, terminalId, visible]);

    useEffect(
      () => () => {
        reportBackgroundFailure(
          setTerminalComposerOverlay(terminalId, false),
          'terminal-composer-overlay-reset',
        );
      },
      [terminalId],
    );

    useEffect(() => {
      // Floating composer/chrome changes are visual-only. On iOS an explicit fit
      // is reserved for a real WebView layout change caused by the direct IME.
      const layoutChanged =
        terminalLayoutKeyboardInsetRef.current !== terminalLayoutKeyboardInset;
      terminalLayoutKeyboardInsetRef.current = terminalLayoutKeyboardInset;
      if (!ready || Platform.OS === 'android' || !layoutChanged) return;
      const timer = setTimeout(() => {
        renderer.current?.fit();
      }, TERMINAL_FIT_DEFER_MS);
      return () => clearTimeout(timer);
    }, [ready, terminalLayoutKeyboardInset]);

    useEffect(() => {
      if (!composeOpen || composeExpanded || !keyboardEnabled) return;
      const timer = setTimeout(
        () => {
          composeInputRef.current?.focus();
        },
        Platform.OS === 'ios'
          ? IOS_COMPOSER_FOCUS_DEFER_MS
          : COMPOSER_FOCUS_DEFER_MS,
      );
      return () => clearTimeout(timer);
    }, [composeExpanded, composeOpen, keyboardEnabled]);

    useEffect(() => {
      if (!ready) return;
      if (!searchOpen) {
        renderer.current?.clearSearch();
        return;
      }
      renderer.current?.search(searchQuery, searchCase, searchRegex, 0);
    }, [ready, searchCase, searchOpen, searchQuery, searchRegex]);

    const pasteClipboard = async () => {
      const value = await Clipboard.getString();
      if (!value) return;
      renderer.current?.paste(value);
      onHistoryEntry(value);
    };

    const moveSearch = (direction: -1 | 1) => {
      renderer.current?.search(searchQuery, searchCase, searchRegex, direction);
    };

    const closeSearch = () => {
      setSearchOpen(false);
      if (keyboardEnabled) {
        setTimeout(() => renderer.current?.focus(), TERMINAL_FOCUS_DEFER_MS);
      }
    };

    const closeComposerKeyboard = async () => {
      composeInputRef.current?.blur();
      renderer.current?.blur();
      if (!keyboardVisible) {
        Keyboard.dismiss();
        return;
      }

      await new Promise<void>(resolve => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const subscription = Keyboard.addListener('keyboardDidHide', () => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          subscription.remove();
          resolve();
        });
        timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          subscription.remove();
          resolve();
        }, 1000);
        Keyboard.dismiss();
      });
    };

    const retryNow = () => {
      renderer.current?.retry();
    };

    const closeCompose = async () => {
      await closeComposerKeyboard();
      setComposeExpanded(false);
      setComposeOpen(false);
      restoreKeyboardAfterCompose();
      await setTerminalComposerOverlay(terminalId, false).catch(reason =>
        setError(String(reason)),
      );
    };

    const openCompose = () => {
      setSearchOpen(false);
      setHistoryOpen(false);
      setTerminalComposerOverlay(terminalId, true)
        .catch(reason => setError(String(reason)))
        .finally(() => {
          keyboardEnabledBeforeComposeRef.current = keyboardEnabled;
          setKeyboardEnabled(true);
          setComposeOpen(true);
        });
    };

    const expandCompose = () => {
      renderer.current?.blur();
      setKeyboardEnabled(true);
      setComposeExpanded(true);
    };

    const collapseCompose = () => {
      setComposeExpanded(false);
      if (keyboardEnabled) {
        setTimeout(
          () => composeInputRef.current?.focus(),
          COMPOSER_COLLAPSE_FOCUS_DEFER_MS,
        );
      }
    };

    const enqueueComposeMessage = (
      text: string,
      attachments: ComposeAttachment[],
    ): boolean => {
      const target = activeTargetRef.current;
      if (target) onInteraction?.(target);
      const submission = composeTerminalSubmission(
        text,
        attachments.map(attachment => attachment.remotePath),
      );
      if (!submission.historyEntry || !target) return false;
      const message: QueuedComposerMessage = {
        id: ++queuedMessageSequenceRef.current,
        text,
        pasteEvents: submission.pasteEvents,
        historyEntry: submission.historyEntry,
        attachments,
        sending: false,
        attempts: 0,
        error: null,
      };
      publishQueuedMessages(target.key, [
        ...(queuedMessagesByTargetRef.current.get(target.key) || []),
        message,
      ]);
      flushQueuedTargetRef.current(target);
      return true;
    };

    enqueueComposerMessageRef.current = (text, attachmentPaths) =>
      enqueueComposeMessage(
        text,
        attachmentPaths.map((remotePath, index) => ({
          id: -(index + 1),
          remotePath,
          previewUri: null,
          dispose: () => {},
        })),
      );

    const submitCompose = () => {
      if (
        !composeTerminalSubmission(
          composeTextRef.current,
          composeAttachmentsRef.current.map(
            attachment => attachment.remotePath,
          ),
        ).historyEntry
      ) {
        reportBackgroundFailure(sendInput(ENTER_INPUT), TERMINAL_INPUT_CONTEXT);
        return;
      }
      if (
        !enqueueComposeMessage(
          composeTextRef.current,
          composeAttachmentsRef.current,
        )
      )
        return;
      composeTextRef.current = '';
      setComposeText('');
      if (terminalId) onComposerDraftChange(terminalId, '');
      composeInputRef.current?.clear();
      if (activeTargetRef.current) {
        composeAttachmentsByTargetRef.current.delete(
          activeTargetRef.current.key,
        );
      }
      composeAttachmentsRef.current = [];
      setComposeAttachments([]);
    };

    const unqueueComposeMessage = (id: number) => {
      const target = activeTargetRef.current;
      if (!target) return;
      const queue = queuedMessagesByTargetRef.current.get(target.key) || [];
      const message = queue.find(item => item.id === id);
      if (!message || message.sending) return;
      const wasHead = queue[0]?.id === id;
      const remaining = queue.filter(item => item.id !== id);
      publishQueuedMessages(target.key, remaining);
      if (wasHead) {
        const retryTimer = queueRetryTimersRef.current.get(target.key);
        if (retryTimer) clearTimeout(retryTimer);
        queueRetryTimersRef.current.delete(target.key);
      }
      const currentText = composeTextRef.current;
      const nextText = [message.text, currentText].filter(Boolean).join('\n');
      composeTextRef.current = nextText;
      setComposeText(nextText);
      onComposerDraftChange(target.session.terminalId, nextText);
      composeInputRef.current?.setNativeProps({ text: nextText });
      composeInputRef.current?.setSelection(nextText.length, nextText.length);
      composeAttachmentsRef.current = [
        ...message.attachments,
        ...composeAttachmentsRef.current,
      ];
      if (composeAttachmentsRef.current.length) {
        composeAttachmentsByTargetRef.current.set(
          target.key,
          composeAttachmentsRef.current,
        );
      }
      setComposeAttachments(composeAttachmentsRef.current);
      if (wasHead && remaining.length) flushQueuedTargetRef.current(target);
    };

    const selectHistoryEntry = (entry: string) => {
      renderer.current?.paste(entry);
      onHistoryEntry(entry);
      setHistoryOpen(false);
    };

    const removeComposeAttachment = (id: number) => {
      const attachment = composeAttachmentsRef.current.find(
        item => item.id === id,
      );
      attachment?.dispose();
      composeAttachmentsRef.current = composeAttachmentsRef.current.filter(
        item => item.id !== id,
      );
      if (activeTargetRef.current) {
        if (composeAttachmentsRef.current.length) {
          composeAttachmentsByTargetRef.current.set(
            activeTargetRef.current.key,
            composeAttachmentsRef.current,
          );
        } else {
          composeAttachmentsByTargetRef.current.delete(
            activeTargetRef.current.key,
          );
        }
      }
      setComposeAttachments(composeAttachmentsRef.current);
    };

    const updateComposeText = (value: string) => {
      if (activeTargetRef.current) onInteraction?.(activeTargetRef.current);
      composeTextRef.current = value;
      setComposeText(value);
      if (terminalId) onComposerDraftChange(terminalId, value);
    };

    const swapArrowControls = (control: TerminalControlId) => {
      setControlOrder(order => swapTerminalArrowControls(order, control));
    };

    const renderTerminalControl = (control: TerminalControlId) => {
      const key = TERMINAL_KEYS[control];
      if (key) {
        const fixedIcon = TERMINAL_KEY_ICONS[control];
        const iconicKey = ICONIC_TERMINAL_KEYS[control];
        const useIconicKey =
          preferences.useModifierKeyIcons && Boolean(iconicKey);
        const icon =
          fixedIcon?.icon ?? (useIconicKey ? iconicKey?.icon : undefined);
        return (
          <TerminalKey
            key={control}
            label={useIconicKey && iconicKey?.label ? iconicKey.label : key[0]}
            icon={icon}
            accessibilityLabel={
              fixedIcon
                ? t(fixedIcon.accessibilityKey)
                : iconicKey
                ? t(iconicKey.accessibilityKey)
                : undefined
            }
            symbolic={!icon && (useIconicKey || key[2] === 'symbol')}
            onLongPress={
              terminalArrowControlCanSwap(control)
                ? () => swapArrowControls(control)
                : undefined
            }
            onPress={() => {
              onControlUse(control);
              reportBackgroundFailure(
                sendInput(key[1]),
                TERMINAL_INPUT_CONTEXT,
              );
            }}
          />
        );
      }
      if (control === 'keyboard') {
        return (
          <TerminalControlButton
            key={control}
            accessibilityLabel={
              keyboardControlSelected
                ? t('terminal.disableKeyboard')
                : t('terminal.enableKeyboard')
            }
            accessibilityState={{
              disabled: keyboardControlDisabled,
              selected: keyboardControlSelected,
            }}
            className={cn(
              TERMINAL_ICON_CONTROL_CLASS,
              keyboardControlSelected && 'border-primary bg-primary/15',
            )}
            disabled={keyboardControlDisabled}
            variant="secondary"
            onPress={() => {
              onControlUse(control);
              const enabled = !keyboardEnabled;
              if (enabled && status === 'connected' && !composeOpen) {
                renderer.current?.setKeyboardEnabled(true);
              }
              setKeyboardEnabled(enabled);
              if (enabled) {
                if (composeOpen) {
                  setTimeout(
                    () => composeInputRef.current?.focus(),
                    COMPOSER_FOCUS_DEFER_MS,
                  );
                } else if (status === 'connected') {
                  setTimeout(
                    () => renderer.current?.focus(),
                    TERMINAL_FOCUS_DEFER_MS,
                  );
                }
              } else {
                Keyboard.dismiss();
                renderer.current?.blur();
              }
            }}
          >
            <View className={TERMINAL_ICON_BOX_CLASS}>
              <KeyboardIcon
                size={TERMINAL_ICON_SIZE}
                color={
                  keyboardControlSelected ? appColors.primary : appColors.text
                }
              />
            </View>
          </TerminalControlButton>
        );
      }
      if (control === 'mouse') {
        const disabled = status !== 'connected' || session?.kind === 'ssh';
        const setEnabled = (enabled: boolean) => {
          renderer.current?.setForcedMouseInput(enabled);
          setForcedMouseInput(enabled);
        };
        return (
          <TerminalControlButton
            key={control}
            accessibilityLabel={t(
              forcedMouseInput
                ? 'terminal.disableForcedMouseInput'
                : 'terminal.enableForcedMouseInput',
            )}
            accessibilityState={{
              disabled,
              selected: forcedMouseInput,
            }}
            className={cn(
              TERMINAL_ICON_CONTROL_CLASS,
              forcedMouseInput && 'border-primary bg-primary/15',
            )}
            disabled={disabled}
            variant="secondary"
            onPress={() => {
              onControlUse(control);
              if (forcedMouseInput) {
                setEnabled(false);
                return;
              }
              setEnabled(true);
              if (claimTerminalMouseWarning()) {
                setForcedMouseInputWarningOpen(true);
              }
            }}
          >
            <View className={TERMINAL_ICON_BOX_CLASS}>
              <MousePointer2
                size={TERMINAL_ICON_SIZE}
                color={forcedMouseInput ? appColors.primary : appColors.text}
              />
            </View>
          </TerminalControlButton>
        );
      }
      if (control === 'paste') {
        return (
          <TerminalControlButton
            key={control}
            accessibilityLabel={t('terminal.paste')}
            className={TERMINAL_ICON_CONTROL_CLASS}
            variant="secondary"
            onPress={() => {
              onControlUse(control);
              pasteClipboard().catch(reason => setError(String(reason)));
            }}
          >
            <View className={TERMINAL_ICON_BOX_CLASS}>
              <ClipboardPaste
                size={TERMINAL_ICON_SIZE}
                color={appColors.text}
              />
            </View>
          </TerminalControlButton>
        );
      }
      if (control === 'history') {
        return (
          <TerminalControlButton
            key={control}
            accessibilityLabel={t('terminal.history')}
            accessibilityState={{ expanded: historyOpen }}
            className={cn(
              TERMINAL_ICON_CONTROL_CLASS,
              historyOpen && 'border-primary',
            )}
            variant="secondary"
            onPress={() => {
              onControlUse(control);
              if (historyOpen) {
                setHistoryOpen(false);
              } else if (composeOpen) {
                reportBackgroundFailure(
                  closeCompose().finally(() => setHistoryOpen(true)),
                  'terminal-compose-close',
                );
              } else {
                setSearchOpen(false);
                setHistoryOpen(true);
              }
            }}
          >
            <View className={TERMINAL_ICON_BOX_CLASS}>
              <History
                size={TERMINAL_ICON_SIZE}
                color={historyOpen ? appColors.primary : appColors.text}
              />
            </View>
          </TerminalControlButton>
        );
      }
      if (control === 'compose') {
        return (
          <TerminalControlButton
            key={control}
            accessibilityLabel={t('terminal.compose')}
            accessibilityState={{ selected: composeOpen }}
            className={cn(
              TERMINAL_ICON_CONTROL_CLASS,
              composeOpen && 'border-primary',
            )}
            variant="secondary"
            onPress={() => {
              onControlUse(control);
              if (composeOpen) {
                reportBackgroundFailure(
                  closeCompose(),
                  'terminal-compose-close',
                );
              } else openCompose();
            }}
          >
            <View className={TERMINAL_ICON_BOX_CLASS}>
              <MessageCircle size={TERMINAL_ICON_SIZE} color={appColors.text} />
            </View>
          </TerminalControlButton>
        );
      }
      if (control === 'chat') {
        if (!chatControl) return null;
        return (
          <TerminalControlButton
            key={control}
            accessibilityLabel={chatControl.accessibilityLabel}
            accessibilityState={{
              busy: chatControl.loading,
              disabled: chatControl.disabled,
              selected: chatControl.active,
            }}
            className={cn(
              TERMINAL_ICON_CONTROL_CLASS,
              chatControl.active && 'border-primary bg-primary/15',
            )}
            disabled={chatControl.disabled}
            variant="secondary"
            onPress={() => {
              onControlUse(control);
              chatControl.onPress();
            }}
          >
            <View className={TERMINAL_ICON_BOX_CLASS}>
              {chatControl.loading ? (
                <AnimatedAgentStatusGlyph
                  status="working"
                  color={appColors.primary}
                  size={TERMINAL_ICON_SIZE}
                />
              ) : chatControl.active ? (
                <SquareTerminal
                  size={TERMINAL_ICON_SIZE}
                  color={appColors.primary}
                />
              ) : (
                <BookOpen size={TERMINAL_ICON_SIZE} color={appColors.text} />
              )}
            </View>
          </TerminalControlButton>
        );
      }
      if (control === 'attach') {
        return (
          <TerminalControlButton
            key={control}
            accessibilityLabel={t('terminal.attach')}
            className={TERMINAL_ICON_CONTROL_CLASS}
            variant="secondary"
            onPress={() => {
              onControlUse(control);
              onRequestAttachment?.();
            }}
          >
            <View className={TERMINAL_ICON_BOX_CLASS}>
              <Paperclip size={TERMINAL_ICON_SIZE} color={appColors.text} />
            </View>
          </TerminalControlButton>
        );
      }
      if (control === 'files') {
        return (
          <TerminalControlButton
            key={control}
            accessibilityLabel={t('terminal.openFiles')}
            className={TERMINAL_ICON_CONTROL_CLASS}
            variant="secondary"
            onPress={() => {
              onControlUse(control);
              onRequestFiles?.();
            }}
          >
            <View className={TERMINAL_ICON_BOX_CLASS}>
              <FolderOpen size={TERMINAL_ICON_SIZE} color={appColors.text} />
            </View>
          </TerminalControlButton>
        );
      }
      if (control === 'links') {
        return (
          <TerminalControlButton
            key={control}
            accessibilityLabel={t('terminal.scanLinks')}
            className={TERMINAL_ICON_CONTROL_CLASS}
            disabled={status !== 'connected'}
            variant="secondary"
            onPress={() => {
              onControlUse(control);
              onRequestLinks?.();
            }}
          >
            <View className={TERMINAL_ICON_BOX_CLASS}>
              <Globe2 size={TERMINAL_ICON_SIZE} color={appColors.text} />
            </View>
          </TerminalControlButton>
        );
      }
      if (control === 'find') {
        return (
          <TerminalControlButton
            key={control}
            accessibilityLabel={t('terminal.find')}
            accessibilityState={{ selected: searchOpen }}
            className={cn(
              TERMINAL_ICON_CONTROL_CLASS,
              searchOpen && 'border-primary',
            )}
            variant="secondary"
            onPress={() => {
              onControlUse(control);
              setHistoryOpen(false);
              if (composeOpen) {
                reportBackgroundFailure(
                  closeCompose().finally(() => {
                    setSearchOpen(true);
                  }),
                  'terminal-compose-close',
                );
              } else {
                setSearchOpen(value => !value);
              }
            }}
          >
            <View className={TERMINAL_ICON_BOX_CLASS}>
              <Search
                size={TERMINAL_ICON_SIZE}
                color={searchOpen ? appColors.primary : appColors.text}
              />
            </View>
          </TerminalControlButton>
        );
      }
      const modifier =
        control === 'ctrl'
          ? {
              value: ctrl,
              setValue: setCtrl,
              icon: ChevronUp,
              label: 'CTRL',
              accessibilityKey: 'terminal.ctrlModifier',
            }
          : control === 'shift'
          ? {
              value: shift,
              setValue: setShift,
              icon: ArrowBigUp,
              label: 'SHIFT',
              accessibilityKey: 'terminal.shiftModifier',
            }
          : control === 'alt'
          ? {
              value: alt,
              setValue: setAlt,
              icon: Option,
              label: 'ALT',
              accessibilityKey: 'terminal.altModifier',
            }
          : null;
      if (!modifier) return null;
      const modifierClassName = cn(
        modifier.value === 'armed' && 'text-primary',
        modifier.value === 'locked' && 'text-primary-foreground',
      );
      return (
        <TerminalControlButton
          key={control}
          accessibilityLabel={t(modifier.accessibilityKey)}
          accessibilityState={{ selected: modifier.value !== 'off' }}
          className={cn(
            preferences.useModifierKeyIcons
              ? TERMINAL_ICON_CONTROL_CLASS
              : TERMINAL_TEXT_CONTROL_CLASS,
            modifier.value === 'armed' && 'border-primary',
            modifier.value === 'locked' &&
              'border-primary bg-primary/70 active:bg-primary/80',
          )}
          delayLongPress={TERMINAL_CONTROL_LONG_PRESS_MS}
          variant="secondary"
          onLongPress={() => modifier.setValue('locked')}
          onPress={() => {
            onControlUse(control);
            modifier.setValue(value => (value === 'off' ? 'armed' : 'off'));
          }}
        >
          {preferences.useModifierKeyIcons ? (
            <TerminalControlIcon
              icon={modifier.icon}
              className={modifierClassName}
            />
          ) : (
            <TerminalControlLabel
              label={modifier.label}
              className={modifierClassName}
            />
          )}
        </TerminalControlButton>
      );
    };

    return (
      <View
        ref={keyboardViewportRef}
        collapsable={false}
        accessibilityElementsHidden={!visible || !session}
        importantForAccessibility={
          visible && session ? 'auto' : 'no-hide-descendants'
        }
        pointerEvents={visible && session ? 'auto' : 'none'}
        shouldRasterizeIOS={Platform.OS === 'ios'}
        className={cn(
          'flex-1 bg-transparent',
          !visible && session && 'absolute inset-0',
          !session && 'absolute inset-0 opacity-0',
        )}
      >
        {!compact && <TerminalBackground preferences={preferences} />}
        {!compact && (
          <View className="h-[30px] flex-row items-center gap-2 border-b border-terminal-divider bg-terminal-panel px-3">
            <View className="size-1.5 rounded-full bg-white" />
            <Text
              numberOfLines={1}
              className="flex-1 text-[9px] tracking-[1px] text-terminal-muted"
            >
              {t('terminal.agentTitle', { title, terminalId })}
            </Text>
            {error && (
              <Text className="text-[8px] text-terminal-error">
                {t('terminal.attachFailed')}
              </Text>
            )}
          </View>
        )}
        {searchOpen && (
          <View className="min-h-12 flex-row items-center gap-1 border-b border-terminal-divider bg-terminal-surface px-[7px]">
            <Input
              autoFocus
              value={searchQuery}
              onChangeText={setSearchQuery}
              onSubmitEditing={() => moveSearch(1)}
              placeholder={t('terminal.findPlaceholder')}
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              className="h-9 min-w-[100px] flex-1 rounded-full border-0 bg-terminal-canvas px-3 font-mono text-[10px] text-terminal-text shadow-none"
            />
            <Button
              className={cn(
                'size-8 rounded-full px-0',
                searchCase && 'bg-terminal-accent',
              )}
              variant="ghost"
              onPress={() => setSearchCase(value => !value)}
            >
              <Text
                className={cn(
                  'font-mono text-[9px] font-extrabold text-terminal-muted',
                  searchCase && 'text-terminal-ink',
                )}
              >
                Aa
              </Text>
            </Button>
            <Button
              className={cn(
                'size-8 rounded-full px-0',
                searchRegex && 'bg-terminal-accent',
              )}
              variant="ghost"
              onPress={() => setSearchRegex(value => !value)}
            >
              <Text
                className={cn(
                  'font-mono text-[9px] font-extrabold text-terminal-muted',
                  searchRegex && 'text-terminal-ink',
                )}
              >
                .*
              </Text>
            </Button>
            <Text
              className={cn(
                'min-w-[34px] text-center font-mono text-[8px] text-terminal-muted',
                (searchResult.invalid ||
                  (searchQuery && searchResult.count === 0)) &&
                  'text-terminal-error',
              )}
            >
              {searchResult.invalid
                ? 'ERR'
                : searchQuery
                ? `${Math.max(0, searchResult.index + 1)}/${searchResult.count}`
                : ''}
            </Text>
            <Button
              accessibilityLabel={t('terminal.previousResult')}
              className="h-[31px] w-7 rounded-none px-0"
              disabled={!searchResult.count}
              variant="ghost"
              onPress={() => moveSearch(-1)}
            >
              <ChevronUp size={16} color={colors.text} />
            </Button>
            <Button
              accessibilityLabel={t('terminal.nextResult')}
              className="h-[31px] w-7 rounded-none px-0"
              disabled={!searchResult.count}
              variant="ghost"
              onPress={() => moveSearch(1)}
            >
              <ChevronDown size={16} color={colors.text} />
            </Button>
            <Button
              accessibilityLabel={t('terminal.closeSearch')}
              className="h-[31px] w-7 rounded-none px-0"
              variant="ghost"
              onPress={closeSearch}
            >
              <X size={17} color={colors.text} />
            </Button>
          </View>
        )}
        <View
          pointerEvents={composeOpen ? 'none' : 'auto'}
          className="relative flex-1"
          style={
            terminalLayoutKeyboardInset > 0
              ? { paddingBottom: terminalLayoutKeyboardInset }
              : undefined
          }
        >
          <TerminalRendererHost
            ref={renderer}
            activeTarget={activeTarget}
            targets={targets}
            visible={visible}
            preferences={preferences}
            visualViewport={terminalVisualViewport}
            offlineTranscript={offlineSnapshot.transcript}
            offlineScroll={offlineSnapshot.scroll}
            onReady={() => {
              setReady(true);
              setForcedMouseInput(false);
            }}
            onInput={async (target, data) => {
              await sendInput(data, target, true);
            }}
            onScroll={(target, direction, lines) => {
              if (target.key === activeTarget?.key) {
                setScrollPosition(current =>
                  moveTerminalScroll(current, direction, lines),
                );
              }
            }}
            onOfflineScroll={(target, scroll) => {
              const mutation = offlineBackendRef.current.updateScroll(
                target.key,
                scroll,
              );
              if (mutation.changed && target.key === activeTarget?.key) {
                setOfflineBackendRevision(value => value + 1);
                setScrollPosition(mutation.snapshot.scroll);
              }
            }}
            onOfflineSnapshot={(targetKey, serialized) => {
              const mutation = offlineBackendRef.current.updateTranscript(
                targetKey,
                terminalSerializedTranscript(serialized),
              );
              const target = activeTargetRef.current;
              if (
                mutation.changed &&
                target?.key === targetKey &&
                target.session.status !== 'connected'
              ) {
                setOfflineBackendRevision(value => value + 1);
              }
            }}
            onSearchResult={(count, index, invalid) =>
              setSearchResult({ count, index, invalid })
            }
            onLinksScanned={links => onLinksScanned?.(links)}
            onOpenLink={link => onOpenLink?.(link)}
            onPaste={(_target, text) => onHistoryEntry(text)}
            onBufferModeChange={(target, alternate) => {
              if (target.key !== activeTarget?.key) return;
              terminalScrollbarDragRef.current = null;
              pendingTerminalScrollRef.current = null;
              setAlternateScreen(alternate);
              setSearchResult({ count: 0, index: -1, invalid: false });
            }}
            onVisualScrollState={(target, nextAtVisualBottom) => {
              setVisualBottomByTarget(current =>
                current[target.key] === nextAtVisualBottom
                  ? current
                  : { ...current, [target.key]: nextAtVisualBottom },
              );
            }}
            onProtocolStateChange={(target, state) => {
              if (target.key === activeTarget?.key) setProtocolState(state);
            }}
            onTitleChange={(target, nextTitle) => {
              if (target.key === activeTarget?.key) setReportedTitle(nextTitle);
            }}
            onFontSizeChange={onFontSizeChange}
            onStatus={(target, nextStatus, nextError, reconnectAttempt) => {
              if (
                nextStatus === 'connected' &&
                target.key === activeTargetRef.current?.key
              ) {
                setError(null);
              }
              onStatus(target, nextStatus, nextError, reconnectAttempt);
            }}
            onError={(target, message) => {
              if (target.key === activeTarget?.key) setError(message);
            }}
            style={WEBVIEW_STYLE}
          />
          {scrollThumb && (
            <OverlayScrollbar
              accessibilityLabel="Terminal scroll position"
              heightPercent={scrollThumb.heightPercent}
              insets={terminalScrollingInsets}
              topPercent={scrollThumb.topPercent}
              onAccessibilityAdjust={adjustTerminalScrollbar}
              onDrag={dragTerminalScrollbar}
              onDragEnd={finishTerminalScrollbarDrag}
              onDragStart={beginTerminalScrollbarDrag}
            />
          )}
          {activeTarget &&
            terminalLatestButtonVisible(alternateScreen, atVisualBottom) && (
              <Button
                accessibilityLabel="Jump to latest terminal output"
                className={cn(
                  'absolute right-4 h-8 flex-row gap-1.5 rounded-full px-3 shadow-lg',
                  appGlassEnabled && 'border',
                )}
                style={[
                  { bottom: terminalLatestButtonOffset },
                  appGlassEnabled
                    ? appGlassControlStyle(false, appColors)
                    : undefined,
                ]}
                variant={appGlassEnabled ? 'ghost' : 'secondary'}
                onPress={jumpTerminalToLatest}
              >
                <ChevronDown size={15} color={appColors.text} />
                <Text className="text-[10px] font-semibold">Latest</Text>
              </Button>
            )}
          {viewportOverlay && (
            <>
              {chatViewEnabled && (
                <View
                  accessibilityElementsHidden
                  pointerEvents="none"
                  className="absolute inset-0 z-10 bg-background"
                >
                  {viewportOverlayBackground}
                </View>
              )}
              <View
                accessibilityElementsHidden={!chatViewEnabled}
                importantForAccessibility={
                  chatViewEnabled ? 'auto' : 'no-hide-descendants'
                }
                pointerEvents={chatViewEnabled ? 'auto' : 'none'}
                className="absolute inset-0 z-20"
                style={{ opacity: chatViewEnabled ? 1 : 0 }}
              >
                {viewportOverlay}
              </View>
            </>
          )}
        </View>
        <TerminalLatencyWarning
          latencyMs={latencyMs}
          top={0}
          visible={Boolean(
            session &&
              status === 'connected' &&
              shouldDisplayLatencyWarning(latencyWarningActive, latencyMs) &&
              !searchOpen,
          )}
        />
        {session && status !== 'connected' && (
          <View
            pointerEvents="box-none"
            className="absolute inset-x-2 z-20"
            style={{ top: 8 }}
          >
            <View className="flex-row items-center gap-2 rounded-lg border border-terminal-divider bg-terminal-panel/95 p-2 shadow-lg">
              <View
                className={cn(
                  'size-2 rounded-full bg-terminal-success',
                  status === 'error' && 'bg-terminal-error',
                )}
              />
              <View className="min-w-0 flex-1">
                <Text
                  numberOfLines={1}
                  className="text-[12px] font-semibold text-terminal-text"
                >
                  {status === 'connecting'
                    ? t('terminal.connecting')
                    : status === 'disconnected'
                    ? t('terminal.reconnecting')
                    : t('terminal.failed')}
                </Text>
                <Text
                  numberOfLines={1}
                  className="text-[9px] text-terminal-muted"
                >
                  {status === 'disconnected' && session.reconnectAttempt > 0
                    ? t('terminal.attempt', {
                        attempt: session.reconnectAttempt,
                        total: 5,
                      })
                    : session.error ||
                      error ||
                      t('terminal.opening', { title })}
                </Text>
              </View>
              {status !== 'connecting' && (
                <Button
                  className="h-8 rounded-full bg-terminal-accent px-3"
                  onPress={retryNow}
                >
                  <Text className="text-[10px] font-semibold text-terminal-ink">
                    {t('terminal.retry')}
                  </Text>
                </Button>
              )}
              <Button
                accessibilityLabel={t('terminal.closeSession')}
                className="size-8 rounded-full px-0"
                variant="ghost"
                onPress={onClose}
              >
                <X size={16} color={colors.text} />
              </Button>
            </View>
          </View>
        )}
        {composeOpen && !composeExpanded && (
          <Portal name={`terminal-composer-${terminalId}`}>
            <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
              <View
                className="absolute inset-x-0 border-t border-terminal-divider bg-transparent p-2"
                style={{
                  bottom: controlBarHeight + keyboardInset,
                }}
                onLayout={event => {
                  const height = Math.round(event.nativeEvent.layout.height);
                  if (height <= 0) return;
                  setComposerHeight(current =>
                    current === height ? current : height,
                  );
                }}
              >
                <MessageComposer
                  glass={appGlassEnabled}
                  initialValue={composeText}
                  inputRef={composeInputRef}
                  autoFocus={keyboardEnabled}
                  showSoftInputOnFocus={keyboardEnabled}
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                  onChangeText={updateComposeText}
                  placeholder={t('terminal.composePlaceholder')}
                  placeholderTextColor={colors.muted}
                  inputClassName="h-[76px] px-4 py-3 font-mono text-[12px] leading-[17px] text-terminal-text"
                  surfaceClassName={cn(
                    'rounded-[38px]',
                    !appGlassEnabled &&
                      'border-terminal-divider bg-terminal-canvas',
                  )}
                  actions={{
                    actionClassName: 'bg-terminal-surface',
                    actionColor: colors.text,
                    attachLabel: t('terminal.attach'),
                    closeLabel: t('terminal.closeCompose'),
                    expandLabel: t('terminal.expandComposer'),
                    onAttach: () => onRequestAttachment?.(),
                    onClose: () => {
                      reportBackgroundFailure(closeCompose(), 'terminal-compose-close');
                    },
                    onExpand: expandCompose,
                    onSend: submitCompose,
                    sendClassName: 'bg-white',
                    sendColor: colors.ink,
                    sendLabel: t('terminal.sendBufferedInput'),
                  }}
                  beforeInput={
                    <>
                      <QueuedMessagesStrip
                        messages={queuedMessages}
                        label={t('terminal.outbox')}
                        queuedLabel={t('terminal.queued')}
                        sendingLabel={t('terminal.sending')}
                        retryingLabel={t('terminal.retrying')}
                        unqueueLabel={t('terminal.unqueue')}
                        onUnqueue={unqueueComposeMessage}
                      />
                      <ComposeAttachmentsStrip
                        attachments={composeAttachments}
                        removeLabel={t('terminal.removeAttachment')}
                        onRemove={removeComposeAttachment}
                      />
                    </>
                  }
                />
              </View>
            </View>
          </Portal>
        )}
        <View
          collapsable={false}
          className="absolute inset-x-0 bottom-0 z-30"
          style={
            keyboardInset > 0
              ? { transform: [{ translateY: -keyboardInset }] }
              : undefined
          }
          onLayout={event => {
            const height = Math.round(event.nativeEvent.layout.height);
            if (height <= 0) return;
            setControlBarHeight(current =>
              current === height ? current : height,
            );
          }}
        >
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            className="flex-grow-0"
            contentContainerClassName="items-center gap-[5px] px-1.5 pt-[7px]"
            contentContainerStyle={{ paddingBottom: 7 + bottomSafeAreaInset }}
          >
            {controlOrder
              .filter(control =>
                terminalControlIsVisible(
                  control,
                  keyboardEnabled,
                  chatViewEnabled,
                ),
              )
              .map(renderTerminalControl)}
          </ScrollView>
        </View>
        {composeOpen && composeExpanded && (
          <Modal
            animationType="slide"
            onRequestClose={collapseCompose}
            onShow={() => {
              setTimeout(
                () => composeInputRef.current?.focus(),
                COMPOSER_FOCUS_DEFER_MS,
              );
            }}
            statusBarTranslucent
            visible
          >
            <View
              className="flex-1 bg-terminal-canvas"
              style={{
                paddingTop: topSafeAreaInset,
                paddingBottom: Math.max(bottomSafeAreaInset, keyboardInset),
              }}
            >
              <View className="h-14 flex-row items-center gap-2 border-b border-terminal-divider bg-terminal-panel px-2">
                <Button
                  accessibilityLabel={t('terminal.collapseComposer')}
                  className="size-10 rounded-full px-0"
                  variant="ghost"
                  onPress={collapseCompose}
                >
                  <Minimize2 size={19} color={colors.text} />
                </Button>
                <View className="min-w-0 flex-1">
                  <Text className="font-mono text-[13px] font-bold text-terminal-text">
                    {t('terminal.expandedComposerTitle')}
                  </Text>
                  <Text
                    numberOfLines={1}
                    className="font-mono text-[9px] text-terminal-muted"
                  >
                    {title}
                  </Text>
                </View>
                <Button
                  accessibilityLabel={t('terminal.sendBufferedInput')}
                  className="h-10 flex-row gap-2 rounded-full bg-white px-4"
                  onPress={submitCompose}
                >
                  <Send size={16} color={colors.ink} />
                  <Text className="font-mono text-[11px] font-bold text-terminal-ink">
                    SEND
                  </Text>
                </Button>
              </View>
              <QueuedMessagesStrip
                messages={queuedMessages}
                label={t('terminal.outbox')}
                queuedLabel={t('terminal.queued')}
                sendingLabel={t('terminal.sending')}
                retryingLabel={t('terminal.retrying')}
                unqueueLabel={t('terminal.unqueue')}
                onUnqueue={unqueueComposeMessage}
                expanded
              />
              <ComposeAttachmentsStrip
                attachments={composeAttachments}
                removeLabel={t('terminal.removeAttachment')}
                onRemove={removeComposeAttachment}
                expanded
              />
              <ComposerInput
                ref={composeInputRef}
                initialValue={composeText}
                autoFocus={keyboardEnabled}
                showSoftInputOnFocus={keyboardEnabled}
                multiline
                textAlignVertical="top"
                onChangeText={updateComposeText}
                placeholder={t('terminal.composePlaceholder')}
                placeholderTextColor={colors.muted}
                className="h-auto min-h-0 flex-1 rounded-none border-0 bg-transparent px-4 py-4 font-mono text-[15px] leading-[22px] text-terminal-text shadow-none"
              />
              <View className="h-14 flex-row items-center border-t border-terminal-divider bg-terminal-panel px-2">
                <Button
                  accessibilityLabel={t('terminal.attach')}
                  className="size-10 rounded-full px-0"
                  variant="ghost"
                  onPress={onRequestAttachment}
                >
                  <Paperclip size={19} color={colors.text} />
                </Button>
                <Text className="ml-auto px-2 font-mono text-[9px] text-terminal-muted">
                  {t('terminal.composeCharacterCount', {
                    count: composeText.length.toLocaleString(),
                  })}
                </Text>
              </View>
            </View>
          </Modal>
        )}
        <Modal
          animationType="fade"
          onRequestClose={() => setHistoryOpen(false)}
          statusBarTranslucent
          transparent
          visible={historyOpen}
        >
          <View className="flex-1 justify-end bg-black/50">
            <Pressable
              accessibilityLabel={t('terminal.closeHistory')}
              className="flex-1"
              onPress={() => setHistoryOpen(false)}
            />
            <View
              className="rounded-t-3xl bg-background px-4 pt-3"
              style={{ paddingBottom: Math.max(16, bottomSafeAreaInset) }}
            >
              <View className="mb-2 flex-row items-center">
                <View className="size-10 items-center justify-center rounded-full bg-muted">
                  <History size={18} color={appColors.text} />
                </View>
                <View className="min-w-0 flex-1 px-3">
                  <Text className="text-[17px] font-bold text-foreground">
                    {t('terminal.historyTitle')}
                  </Text>
                  <Text className="text-[11px] text-muted-foreground">
                    {t('terminal.historyCopy')}
                  </Text>
                </View>
                <Button
                  accessibilityLabel={t('terminal.closeHistory')}
                  className="size-10 rounded-full px-0"
                  variant="ghost"
                  onPress={() => setHistoryOpen(false)}
                >
                  <X size={19} color={appColors.text} />
                </Button>
              </View>
              {historyEntries.length === 0 ? (
                <View className="h-32 items-center justify-center px-6">
                  <Text className="text-center text-[13px] text-muted-foreground">
                    {t('terminal.historyEmpty')}
                  </Text>
                </View>
              ) : (
                <ScrollView
                  className="max-h-[420px]"
                  keyboardShouldPersistTaps="always"
                  showsVerticalScrollIndicator={false}
                >
                  {historyEntries.map((entry, index) => (
                    <Button
                      key={entry}
                      accessibilityLabel={t('terminal.useHistoryEntry', {
                        text: entry,
                      })}
                      className={cn(
                        'min-h-12 justify-start rounded-none px-2.5 py-2.5',
                        index > 0 && 'border-t border-border',
                      )}
                      variant="ghost"
                      onPress={() => selectHistoryEntry(entry)}
                    >
                      <Text
                        numberOfLines={3}
                        className="flex-1 text-left font-mono text-[14px] leading-5 text-foreground"
                        style={{ fontFamily: terminalFontFamily }}
                      >
                        {entry}
                      </Text>
                    </Button>
                  ))}
                </ScrollView>
              )}
            </View>
          </View>
        </Modal>
        <AppAlertPopup
          actionLabel={t('common.close')}
          message={t('terminal.forceMouseInputWarning')}
          title={t('terminal.forceMouseInputTitle')}
          visible={forcedMouseInputWarningOpen}
          onClose={() => setForcedMouseInputWarningOpen(false)}
        />
      </View>
    );
  },
);

interface QueuedComposerMessage {
  id: number;
  text: string;
  pasteEvents: string[];
  historyEntry: string;
  attachments: ComposeAttachment[];
  sending: boolean;
  attempts: number;
  error: string | null;
}

function QueuedMessagesStrip({
  messages,
  label,
  queuedLabel,
  sendingLabel,
  retryingLabel,
  unqueueLabel,
  onUnqueue,
  expanded = false,
}: {
  messages: readonly QueuedComposerMessage[];
  label: string;
  queuedLabel: string;
  sendingLabel: string;
  retryingLabel: string;
  unqueueLabel: string;
  onUnqueue: (id: number) => void;
  expanded?: boolean;
}) {
  if (!messages.length) return null;
  return (
    <View
      className={cn(
        expanded
          ? 'border-b border-terminal-divider px-3 py-3'
          : 'border-b border-terminal-divider px-2 py-2',
      )}
    >
      <Text className="mb-1.5 font-mono text-[9px] font-bold uppercase tracking-widest text-terminal-muted">
        {label} · {messages.length}
      </Text>
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2"
      >
        {messages.map(message => (
          <View
            key={message.id}
            className="h-12 w-56 flex-row items-center gap-2 rounded-md border border-terminal-divider bg-terminal-surface px-2"
          >
            <View className="min-w-0 flex-1">
              <Text
                numberOfLines={1}
                className="font-mono text-[10px] text-terminal-text"
              >
                {message.historyEntry}
              </Text>
              <Text
                numberOfLines={1}
                className={cn(
                  'font-mono text-[8px] text-terminal-muted',
                  message.error && 'text-terminal-error',
                )}
              >
                {message.sending
                  ? sendingLabel
                  : message.error
                  ? `${retryingLabel}: ${message.error}`
                  : queuedLabel}
              </Text>
            </View>
            <Button
              accessibilityLabel={unqueueLabel}
              className="size-8 rounded-full px-0"
              disabled={message.sending}
              variant="ghost"
              onPress={() => onUnqueue(message.id)}
            >
              <Undo2
                size={15}
                color={message.sending ? colors.muted : colors.text}
              />
            </Button>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

interface ComposeAttachment {
  id: number;
  remotePath: string;
  previewUri: string | null;
  dispose: () => void;
}

function ComposeAttachmentsStrip({
  attachments,
  expanded = false,
  removeLabel,
  onRemove,
}: {
  attachments: readonly ComposeAttachment[];
  expanded?: boolean;
  removeLabel: string;
  onRemove: (id: number) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      className={cn(
        'flex-grow-0',
        expanded ? 'border-b border-terminal-divider px-3 py-3' : 'mx-2 mt-2',
      )}
      contentContainerClassName="gap-2"
    >
      {attachments.map(attachment => (
        <View
          key={attachment.id}
          className="relative size-16 overflow-hidden rounded-lg border border-terminal-divider bg-terminal-surface"
        >
          {attachment.previewUri ? (
            <Image
              className="size-full"
              resizeMode="cover"
              source={{ uri: attachment.previewUri }}
            />
          ) : (
            <View className="size-full items-center justify-center">
              <Paperclip size={23} color={colors.muted} />
            </View>
          )}
          <Button
            accessibilityLabel={removeLabel}
            className="absolute right-0 top-0 size-11 items-end justify-start rounded-none bg-transparent p-0 active:bg-transparent"
            onPress={() => onRemove(attachment.id)}
          >
            <View className="size-6 items-center justify-center rounded-full bg-black/75">
              <X size={13} color="#fff" />
            </View>
          </Button>
        </View>
      ))}
    </ScrollView>
  );
}

function TerminalControlButton(props: ButtonProps) {
  return <Button hitSlop={TERMINAL_CONTROL_HIT_SLOP} {...props} />;
}

function TerminalKey({
  label,
  icon,
  accessibilityLabel,
  symbolic = false,
  onLongPress,
  onPress,
}: {
  label: string;
  icon?: LucideIcon;
  accessibilityLabel?: string;
  symbolic?: boolean;
  onLongPress?: () => void;
  onPress: () => void;
}) {
  return (
    <TerminalControlButton
      accessibilityLabel={accessibilityLabel}
      className={
        icon || symbolic
          ? TERMINAL_ICON_CONTROL_CLASS
          : TERMINAL_TEXT_CONTROL_CLASS
      }
      delayLongPress={TERMINAL_CONTROL_LONG_PRESS_MS}
      variant="secondary"
      onLongPress={onLongPress}
      onPress={onPress}
    >
      {icon ? (
        <TerminalControlIcon icon={icon} />
      ) : (
        <TerminalControlLabel label={label} symbolic={symbolic} />
      )}
    </TerminalControlButton>
  );
}

function TerminalControlIcon({
  icon,
  className,
}: {
  icon: LucideIcon;
  className?: string;
}) {
  return (
    <View className={TERMINAL_ICON_BOX_CLASS}>
      <Icon as={icon} size={TERMINAL_ICON_SIZE} className={className} />
    </View>
  );
}

function TerminalControlLabel({
  label,
  symbolic = false,
  className,
}: {
  label: string;
  symbolic?: boolean;
  className?: string;
}) {
  const text = (
    <Text
      allowFontScaling={false}
      numberOfLines={1}
      className={cn(
        'text-center font-mono font-bold text-foreground',
        symbolic ? 'text-[18px] leading-5' : 'text-[12px] leading-4',
        className,
      )}
      style={TERMINAL_CONTROL_LABEL_STYLE}
    >
      {label}
    </Text>
  );
  return symbolic ? (
    <View className={TERMINAL_ICON_BOX_CLASS}>{text}</View>
  ) : (
    text
  );
}
