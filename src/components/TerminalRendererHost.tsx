import {
  forwardRef,
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
} from 'react';
import {
  AppState,
  Platform,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import WebView from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview/lib/WebViewTypes';

import type { TerminalFrame, TerminalProtocolState } from '../lib/terminalBridge';
import { TerminalFrameSequence } from '../lib/terminalFrameSequence';
import {
  TerminalArbitration,
  type TerminalDimensions,
  type TerminalInputActivity,
} from '../lib/terminalArbitration';
import { arrayBufferToBase64 } from '../lib/base64';
import {
  isOfflineTerminalNavigationInput,
  TerminalRendererContentState,
  terminalResizeForcesNativeDispatch,
  terminalScrollbackMode,
  type TerminalRenderTarget,
  type TerminalVisualViewport,
} from '../lib/terminalRenderer';
import { prepareTerminalPaste } from '../lib/terminalPaste';
import {
  resumedTerminalScrollOffset,
  type TerminalResumeViewport,
} from '../lib/terminalScroll';
import { terminalSubmissionWrites } from '../lib/terminalSubmission';
import { isUnknownRecord, stringArray } from '../lib/unknown';
import {
  terminalRendererEvictionKeys,
  touchTerminalRendererEntry,
} from '../lib/terminalRendererLru';
import type { TerminalPreferences } from '../services/devicePreferences';
import { bestEffortCleanup } from '../services/backgroundOperations';
import type { TerminalAttachmentId } from '../services/TerminalBridgeController';
import { networkErrorMessage, recordNetworkDiagnostic } from '../services/networkDiagnostics';
import {
  abandonTerminalInboundTrace,
  abandonTerminalRendererReadinessTrace,
  abandonTerminalResizeTrace,
  beginAppPerformanceTrace,
  beginTerminalColdInputWait,
  beginTerminalInputTrace,
  beginTerminalRendererReadinessTrace,
  beginTerminalResizeTrace,
  endAppPerformanceTrace,
  endTerminalWriteTrace,
  terminalInboundBase64Ended,
  terminalInboundBase64Started,
  terminalInboundFrameVisible,
  terminalInboundRendererReceived,
  terminalInboundScriptBuildEnded,
  terminalInboundScriptBuildStarted,
  terminalInboundWebViewInjectionEnded,
  terminalInboundWebViewInjectionStarted,
  terminalInboundWebViewReceived,
  terminalInboundXtermWritten,
  terminalFrameReceived,
  terminalFrameRendered,
  terminalRendererBecameReady,
  terminalRendererEntryReached,
  terminalRendererSizeBecameReady,
  terminalResizeFrameReceived,
  terminalResizeFrameRendered,
  terminalResizeRequestHandled,
  terminalResizeRequestReady,
  withTerminalWriteTrace,
  type AppPerformanceTrace,
  type TerminalRendererReadinessTrace,
} from '../services/performanceTrace';
import { IOS_TERMINAL_ASSETS } from '../services/terminalAssets';
import type { TerminalSessionStatus } from '../terminalSessions';
import type { PaneScrollInfo } from '../types';

const FRAME_CHUNK_SIZE = 16_384;
const TRANSCRIPT_CHUNK_SIZE = 16_384;
const WEBVIEW_CONTAINER_STYLE = { backgroundColor: 'transparent' } as const;
const IOS_TERMINAL_ASSET_DIRECTORY = IOS_TERMINAL_ASSETS?.directoryURL || '';
const runtimeProcess: unknown = process;
const TERMINAL_RENDER_DROP_ENABLED = __DEV__
  && isUnknownRecord(runtimeProcess)
  && isUnknownRecord(runtimeProcess.env)
  && runtimeProcess.env.EXPO_PUBLIC_WHIP_TERMINAL_RENDER_DROP === '1';
const TERMINAL_SOURCE = Platform.select({
  android: { uri: 'file:///android_asset/herdr-terminal.html' },
  ios: { uri: IOS_TERMINAL_ASSETS?.indexURL || 'about:blank' },
  default: { uri: 'about:blank' },
});
const DEFAULT_TERMINAL_VISUAL_VIEWPORT: TerminalVisualViewport = {
  insets: { top: 0, bottom: 0 },
  geometryBottomInset: 0,
};

interface TerminalWebMessage extends Record<string, unknown> {
  type: string;
}

function parseTerminalWebMessage(serialized: string): TerminalWebMessage | null {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!isUnknownRecord(value) || typeof value.type !== 'string') return null;
    return { ...value, type: value.type };
  } catch {
    return null;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function terminalFrameByteLength(frame: TerminalFrame): number {
  if (typeof frame.bytes !== 'string') return frame.bytes.byteLength;
  if (frame.encoding !== 'ansi') return frame.bytes.length;
  const padding = frame.bytes.endsWith('==') ? 2 : frame.bytes.endsWith('=') ? 1 : 0;
  return Math.floor(frame.bytes.length * 3 / 4) - padding;
}

interface WebViewHandle {
  injectJavaScript: (script: string) => void;
  requestFocus: () => void;
}

interface RendererEntry {
  target: TerminalRenderTarget;
  rendererReady: boolean;
  sizeReady: boolean;
  controllerAttached: boolean;
  controllerAttachment: Promise<TerminalAttachmentId> | null;
  connecting: boolean;
  pendingFrames: Array<{
    frame: TerminalFrame;
    inputTraceCookie: number | null;
    resizeTraceCookie: number | null;
  }>;
  resetOnNextFrame: boolean;
  contentState: TerminalRendererContentState;
  frameSequence: TerminalFrameSequence;
  repaintRequested: boolean;
  fontPreference: number;
  fontSize: number;
  protocolState: TerminalProtocolState;
  alternateScreen: boolean;
  arbitration: TerminalArbitration;
  writableWaiters: Array<{
    resolve: () => void;
    reject: (reason: Error) => void;
  }>;
  readinessTrace: TerminalRendererReadinessTrace | null;
}

interface TerminalResumeScrollState {
  checkpoint: TerminalResumeViewport;
  connectionSettled: boolean;
  finalResizeSettled: boolean;
  restoring: boolean;
}

export interface TerminalRendererHandle {
  blur: () => void;
  cancelPendingResumeScroll: () => void;
  changeFontSize: (delta: -1 | 1) => void;
  clearSearch: () => void;
  fit: () => void;
  focus: () => void;
  input: (data: string) => boolean;
  paste: (data: string) => void;
  retry: () => void;
  scanLinks: () => void;
  scroll: (direction: 'up' | 'down', lines: number) => void;
  scrollToVisualBottom: () => void;
  search: (query: string, caseSensitive: boolean, regex: boolean, direction: number) => void;
  setForcedMouseInput: (enabled: boolean) => void;
  setKeyboardEnabled: (enabled: boolean) => void;
  submitPastes: (
    target: TerminalRenderTarget,
    parts: readonly string[],
    newUserInput?: boolean,
  ) => Promise<void>;
}

interface Props {
  activeTarget: TerminalRenderTarget | null;
  targets: readonly TerminalRenderTarget[];
  visible: boolean;
  preferences: TerminalPreferences;
  visualViewport?: TerminalVisualViewport;
  offlineTranscript?: string;
  offlineScroll?: PaneScrollInfo;
  style?: StyleProp<ViewStyle>;
  onReady?: () => void;
  onInput: (target: TerminalRenderTarget, data: string) => void | Promise<void>;
  onScroll: (target: TerminalRenderTarget, direction: 'up' | 'down', lines: number) => void;
  onOfflineScroll: (target: TerminalRenderTarget, scroll: PaneScrollInfo) => void;
  onOfflineSnapshot: (targetKey: string, transcript: string) => void;
  onSearchResult: (count: number, index: number, invalid: boolean) => void;
  onLinksScanned: (links: string[]) => void;
  onOpenLink: (link: string) => void;
  onPaste: (target: TerminalRenderTarget, text: string) => void;
  onBufferModeChange: (target: TerminalRenderTarget, alternate: boolean) => void;
  onVisualScrollState: (
    target: TerminalRenderTarget,
    atVisualBottom: boolean,
  ) => void;
  onProtocolStateChange: (target: TerminalRenderTarget, state: TerminalProtocolState) => void;
  onTitleChange: (target: TerminalRenderTarget, title: string) => void;
  onFontSizeChange: (target: TerminalRenderTarget, fontSize: number) => void;
  onStatus: (
    target: TerminalRenderTarget,
    status: TerminalSessionStatus,
    error?: string,
    reconnectAttempt?: number,
  ) => void;
  onError: (target: TerminalRenderTarget, error: string) => void;
}

export const TerminalRendererHost = forwardRef<TerminalRendererHandle, Props>(function TerminalRendererHostComponent({
  activeTarget,
  targets,
  visible,
  preferences,
  visualViewport = DEFAULT_TERMINAL_VISUAL_VIEWPORT,
  offlineTranscript = '',
  offlineScroll,
  style,
  onReady,
  onInput,
  onScroll,
  onOfflineScroll,
  onOfflineSnapshot,
  onSearchResult,
  onLinksScanned,
  onOpenLink,
  onPaste,
  onBufferModeChange,
  onVisualScrollState,
  onProtocolStateChange,
  onTitleChange,
  onFontSizeChange,
  onStatus,
  onError,
}, forwardedRef) {
  const webView = useRef<WebViewHandle | null>(null);
  const hostReady = useRef(false);
  const entries = useRef(new Map<string, RendererEntry>());
  const resumeScrolls = useRef(new Map<string, TerminalResumeScrollState>());
  const knownTargets = useRef(new Map<string, TerminalRenderTarget>());
  const activeKey = useRef<string | null>(null);
  const appState = useRef(AppState.currentState);
  const offlineTranscriptRef = useRef(offlineTranscript);
  const offlineScrollRef = useRef(offlineScroll);
  const visualViewportRef = useRef(visualViewport);
  const serializationTraces = useRef(new Map<string, AppPerformanceTrace>());
  activeKey.current = activeTarget?.key || null;
  offlineTranscriptRef.current = offlineTranscript;
  offlineScrollRef.current = offlineScroll;
  visualViewportRef.current = visualViewport;

  const reportReady = useEffectEvent(() => onReady?.());
  const reportInput = useEffectEvent(onInput);
  const reportScroll = useEffectEvent(onScroll);
  const reportOfflineScroll = useEffectEvent(onOfflineScroll);
  const reportOfflineSnapshot = useEffectEvent(onOfflineSnapshot);
  const reportSearch = useEffectEvent(onSearchResult);
  const reportLinks = useEffectEvent(onLinksScanned);
  const reportOpenLink = useEffectEvent(onOpenLink);
  const reportPaste = useEffectEvent(onPaste);
  const reportBufferMode = useEffectEvent(onBufferModeChange);
  const reportVisualScrollState = useEffectEvent(onVisualScrollState);
  const reportProtocolState = useEffectEvent(onProtocolStateChange);
  const reportTitle = useEffectEvent(onTitleChange);
  const reportFontSize = useEffectEvent(onFontSizeChange);
  // Herdr terminal transport state is projected exclusively from HostRuntime
  // events in App. The plain SSH fallback has no Herdr terminal runtime.
  const reportStatus = useEffectEvent((
    target: TerminalRenderTarget,
    status: TerminalSessionStatus,
    error?: string,
    reconnectAttempt?: number,
  ) => {
    if (target.session.kind === 'ssh') {
      onStatus(target, status, error, reconnectAttempt);
    }
  });
  const reportError = useEffectEvent(onError);

  const inject = useCallback((script: string) => {
    webView.current?.injectJavaScript(`${script} true;`);
  }, []);

  const relinquishController = useCallback((
    entry: RendererEntry,
    releaseBridge: boolean,
  ) => {
    const attachment = entry.controllerAttachment;
    entry.controllerAttachment = null;
    entry.controllerAttached = false;
    entry.connecting = false;
    if (!attachment) return;
    const { client, session } = entry.target;
    bestEffortCleanup(
      attachment.then(attachmentId => (
        releaseBridge
          ? client.terminal.releaseTerminal(session.terminalId, attachmentId)
          : client.terminal.detachTerminal(session.terminalId, attachmentId)
      )),
      'terminal-controller-release',
    );
  }, []);

  const disposeEntry = useCallback((
    key: string,
    entry: RendererEntry,
    closeBridge: boolean,
  ) => {
    resumeScrolls.current.delete(key);
    abandonTerminalRendererReadinessTrace(entry.readinessTrace);
    entry.readinessTrace = null;
    for (const waiter of entry.writableWaiters.splice(0)) {
      waiter.reject(new Error('Terminal renderer was disposed'));
    }
    entries.current.delete(key);
    const terminalId = entry.target.session.terminalId;
    if (closeBridge) {
      entry.controllerAttachment = null;
      entry.controllerAttached = false;
      entry.connecting = false;
      entry.target.client.terminal.closeTerminalBridge(terminalId);
    } else {
      relinquishController(entry, false);
    }
    if (hostReady.current) {
      const serializedKey = JSON.stringify(key);
      const snapshot = !closeBridge
        && entry.target.session.kind !== 'ssh'
        && entry.contentState.hasRenderedState
        ? `window.herdrSnapshot(${serializedKey}, "eviction"); `
        : '';
      inject(`${snapshot}window.herdrRemove(${serializedKey});`);
    }
  }, [inject, relinquishController]);

  const pruneEntries = useCallback((protectedKeys: ReadonlySet<string>) => {
    const evictions = terminalRendererEvictionKeys(
      [...entries.current.keys()],
      preferences.xtermCacheCapacity,
      protectedKeys,
    );
    for (const key of evictions) {
      const entry = entries.current.get(key);
      if (entry) disposeEntry(key, entry, false);
    }
  }, [disposeEntry, preferences.xtermCacheCapacity]);

  const configureEntry = useCallback((entry: RendererEntry) => {
    const scrollbackMode = terminalScrollbackMode(entry.target.session);
    const currentVisualViewport = visualViewportRef.current;
    const visualScroll = entry.target.key === activeKey.current
      ? currentVisualViewport.scroll
      : entry.target.scroll;
    inject(`window.herdrConfigure(${JSON.stringify(entry.target.key)}, ${JSON.stringify({
      ...preferences,
      fontSize: entry.fontSize,
      backgroundImageUri: null,
      ...scrollbackMode,
      offlineCache: entry.target.session.kind !== 'ssh',
    })}); window.herdrSetVisualInsets(${JSON.stringify(entry.target.key)}, ${JSON.stringify({
      top: currentVisualViewport.insets.top,
      bottom: currentVisualViewport.insets.bottom,
      geometryBottomInset: currentVisualViewport.geometryBottomInset,
      debug: preferences.visualHints,
      alternateScreen: entry.target.key === activeKey.current
        ? currentVisualViewport.alternateScreen
        : undefined,
      scrollOffsetFromBottom: visualScroll?.offset_from_bottom,
      maxScrollOffsetFromBottom: visualScroll?.max_offset_from_bottom,
    })}); window.herdrSetRenderDrop(${JSON.stringify(entry.target.key)}, ${TERMINAL_RENDER_DROP_ENABLED});`);
  }, [inject, preferences]);

  const syncOfflineTranscript = useCallback((
    entry: RendererEntry,
    transcript: string,
    scroll?: PaneScrollInfo,
  ) => {
    const key = JSON.stringify(entry.target.key);
    const action = entry.contentState.restoreAction(entry.target.session.kind, transcript);
    if (action === 'hide') {
      inject(`window.herdrHideOfflineTranscript(${key});`);
      return;
    }
    // A mounted renderer already contains the interpreted live xterm state.
    // Replaying a cache here would replace newer scrollback with a stale copy.
    if (action === 'preserve') return;
    inject(`window.herdrBeginOfflineTranscript(${key});`);
    for (let offset = 0; offset < transcript.length; offset += TRANSCRIPT_CHUNK_SIZE) {
      inject(`window.herdrAppendOfflineTranscript(${key}, ${JSON.stringify(
        transcript.slice(offset, offset + TRANSCRIPT_CHUNK_SIZE),
      )});`);
    }
    inject(`window.herdrCommitOfflineTranscript(${key}, ${scroll?.offset_from_bottom || 0});`);
    entry.contentState.restoredFromCache();
  }, [inject]);

  const requestFullFrame = useCallback((entry: RendererEntry) => {
    if (entry.repaintRequested) return;
    const dimensions = entry.arbitration.latestDimensions();
    if (!dimensions) return;
    entry.repaintRequested = true;
    const trace = beginAppPerformanceTrace('Whip terminal sequence recovery');
    recordNetworkDiagnostic('warn', 'terminal-sequence-gap', {
      sessionId: entry.target.hostSessionId,
      terminalId: entry.target.session.terminalId,
    });
    entry.target.client.terminal.resizeTerminal(
      entry.target.session.terminalId,
      dimensions.columns,
      dimensions.rows,
      dimensions.cellWidthPx,
      dimensions.cellHeightPx,
      null,
      // Herdr marks every terminal-ANSI resize as repaint_pending. The next
      // frame is therefore a full visible baseline without a pane.read.
      true,
    ).catch(reason => {
      entry.repaintRequested = false;
      reportError(entry.target, String(reason));
    }).finally(() => endAppPerformanceTrace(trace));
  }, []);

  const cancelResumeScroll = useCallback((entry: RendererEntry) => {
    resumeScrolls.current.delete(entry.target.key);
  }, []);

  const maybeRestoreResumeScroll = useCallback((
    entry: RendererEntry,
    state: TerminalResumeScrollState,
  ) => {
    if (
      state.restoring
      || !state.connectionSettled
      || !state.finalResizeSettled
      || resumeScrolls.current.get(entry.target.key) !== state
    ) return;
    if (
      appState.current !== 'active'
      || entry.target.session.kind === 'ssh'
      || entry.target.session.status !== 'connected'
      || entry.alternateScreen
    ) {
      resumeScrolls.current.delete(entry.target.key);
      return;
    }

    state.restoring = true;
    const { client, session } = entry.target;
    client.snapshot().then(async snapshot => {
      if (
        resumeScrolls.current.get(entry.target.key) !== state
        || entries.current.get(entry.target.key) !== entry
        || appState.current !== 'active'
        || entry.alternateScreen
      ) return;
      const current = snapshot.panes.find(
        pane => pane.terminal_id === session.terminalId,
      )?.scroll;
      if (!current) {
        resumeScrolls.current.delete(entry.target.key);
        return;
      }
      const desiredOffset = resumedTerminalScrollOffset(
        state.checkpoint,
        current.max_offset_from_bottom,
      );
      const delta = desiredOffset - current.offset_from_bottom;
      if (delta !== 0) {
        await client.terminal.scrollTerminal(
          session.terminalId,
          delta > 0 ? 'up' : 'down',
          Math.abs(delta),
        );
      }
      if (resumeScrolls.current.get(entry.target.key) === state) {
        resumeScrolls.current.delete(entry.target.key);
      }
    }).catch(reason => {
      if (resumeScrolls.current.get(entry.target.key) === state) {
        resumeScrolls.current.delete(entry.target.key);
      }
      recordNetworkDiagnostic('warn', 'terminal-resume-scroll-restore-failed', {
        sessionId: entry.target.hostSessionId,
        terminalId: session.terminalId,
        reason: networkErrorMessage(reason),
      });
    });
  }, []);

  const settleResumeConnection = useCallback((entry: RendererEntry) => {
    const state = resumeScrolls.current.get(entry.target.key);
    if (!state) return;
    state.connectionSettled = true;
    maybeRestoreResumeScroll(entry, state);
  }, [maybeRestoreResumeScroll]);

  const settleResumeResize = useCallback((
    entry: RendererEntry,
    state: TerminalResumeScrollState | undefined,
  ) => {
    if (!state || resumeScrolls.current.get(entry.target.key) !== state) return;
    state.finalResizeSettled = true;
    maybeRestoreResumeScroll(entry, state);
  }, [maybeRestoreResumeScroll]);

  const injectFrame = useCallback((
    entry: RendererEntry,
    frame: TerminalFrame,
    inputTraceCookie: number | null = terminalFrameReceived(entry.target.key),
    resizeTraceCookie: number | null = terminalResizeFrameReceived(entry.target.key),
  ) => {
    const inboundTraceCookie = frame.inboundTraceCookie ?? null;
    terminalInboundRendererReceived(inboundTraceCookie, terminalFrameByteLength(frame));
    if (!hostReady.current || !entry.rendererReady) {
      entry.pendingFrames.push({ frame, inputTraceCookie, resizeTraceCookie });
      return;
    }
    if (entry.target.session.kind !== 'ssh' && frame.encoding === 'ansi') {
      const sequence = entry.frameSequence.observe(frame);
      if (sequence.requestFull) requestFullFrame(entry);
      if (!sequence.render) {
        abandonTerminalInboundTrace(inboundTraceCookie);
        return;
      }
      if (sequence.reset) entry.resetOnNextFrame = true;
      if (frame.full) entry.repaintRequested = false;
    }
    const key = JSON.stringify(entry.target.key);
    const serializedInputTraceCookie = inputTraceCookie === null
      ? 'null'
      : String(inputTraceCookie);
    const serializedResizeTraceCookie = resizeTraceCookie === null
      ? 'null'
      : String(resizeTraceCookie);
    const reset = entry.resetOnNextFrame;
    if (reset) entry.resetOnNextFrame = false;
    entry.contentState.receivedLiveFrame();
    const resetScript = reset ? `window.herdrReset(${key}); ` : '';
    const serializedInboundTraceCookie = inboundTraceCookie === null
      ? 'null'
      : String(inboundTraceCookie);
    const injectTracedFrame = (script: string) => {
      terminalInboundWebViewInjectionStarted(inboundTraceCookie);
      try {
        inject(script);
      } finally {
        terminalInboundWebViewInjectionEnded(inboundTraceCookie);
      }
    };
    if (frame.encoding === 'utf8') {
      if (typeof frame.bytes !== 'string') {
        abandonTerminalInboundTrace(inboundTraceCookie);
        return;
      }
      injectTracedFrame(`${resetScript}window.herdrWrite(${key}, ${JSON.stringify(frame.bytes)}, ${serializedInputTraceCookie}, ${serializedResizeTraceCookie}, ${serializedInboundTraceCookie});`);
      return;
    }
    if (typeof frame.bytes === 'string' && typeof frame.final === 'boolean') {
      injectTracedFrame(`${resetScript}window.herdrWriteBase64Chunk(${key}, ${frame.seq}, ${JSON.stringify(frame.bytes)}, ${frame.final}, ${serializedInputTraceCookie}, ${serializedResizeTraceCookie}, ${serializedInboundTraceCookie});`);
      return;
    }
    terminalInboundBase64Started(inboundTraceCookie);
    const encoded = typeof frame.bytes === 'string'
      ? frame.bytes
      : arrayBufferToBase64(frame.bytes);
    terminalInboundBase64Ended(inboundTraceCookie);
    terminalInboundScriptBuildStarted(inboundTraceCookie);
    const writes: string[] = [];
    if (encoded.length === 0) {
      writes.push(`window.herdrWriteBase64Chunk(${key}, ${frame.seq}, "", true, ${serializedInputTraceCookie}, ${serializedResizeTraceCookie}, ${serializedInboundTraceCookie});`);
    } else {
      for (let offset = 0; offset < encoded.length; offset += FRAME_CHUNK_SIZE) {
        const chunk = encoded.slice(offset, offset + FRAME_CHUNK_SIZE);
        const final = offset + FRAME_CHUNK_SIZE >= encoded.length;
        const finalTraceCookie = final
          ? `, ${serializedInputTraceCookie}, ${serializedResizeTraceCookie}, ${serializedInboundTraceCookie}`
          : '';
        writes.push(`window.herdrWriteBase64Chunk(${key}, ${frame.seq}, ${JSON.stringify(chunk)}, ${final}${finalTraceCookie});`);
      }
    }
    // A frame can require multiple chunks, but it crosses into the WebView once.
    const script = `${resetScript}${writes.join('')}`;
    terminalInboundScriptBuildEnded(inboundTraceCookie);
    injectTracedFrame(script);
  }, [inject, requestFullFrame]);

  const connectEntry = useCallback((entry: RendererEntry, showConnecting = true) => {
    // Herdr's direct attachment holds the pane's resize lock until released.
    if (entry.target.session.kind !== 'ssh' && appState.current !== 'active') return;
    if (entry.arbitration.state.yielded) return;
    // Opening the remote terminal before xterm has measured the WebView starts
    // it at HerdrClient's 80x24 fallback and immediately sends a second resize.
    // Wait for the configured renderer's first measured size instead.
    if (!entry.rendererReady || !entry.sizeReady) return;
    if (entry.connecting || entry.controllerAttached) return;
    entry.connecting = true;
    entry.controllerAttached = true;
    const { client, session } = entry.target;
    const terminalId = session.terminalId;
    const retained = client.terminal.isTerminalBridgeRetained(terminalId);
    if (!retained) {
      entry.resetOnNextFrame = true;
      entry.pendingFrames = [];
      entry.frameSequence.reset();
      entry.repaintRequested = false;
      if (showConnecting) {
        reportStatus(entry.target, 'connecting', undefined, 0);
      }
    }
    const scheduleReconnect = (reason: string, displacement: boolean) => {
      if (entries.current.get(entry.target.key) !== entry) return;
      entry.connecting = false;
      entry.controllerAttached = false;
      if (AppState.currentState !== 'active') return;
      if (
        displacement
        && entry.target.session.kind !== 'ssh'
        && entry.arbitration.recordDisplacement()
      ) {
        recordNetworkDiagnostic('info', 'terminal-reconnect-yielded', {
          sessionId: entry.target.hostSessionId,
          terminalId,
          inputGeneration: entry.arbitration.state.inputGeneration,
          displacements: entry.arbitration.state.consecutiveDisplacements,
          reason: networkErrorMessage(reason),
        });
        // There is no passive terminal status. Keep the cached surface usable
        // so its next real input can reclaim ownership through this host.
        reportStatus(entry.target, 'connected', undefined, 0);
        relinquishController(entry, true);
        return;
      }
      // HostRuntime owns terminal retry/backoff and native bridge generations.
      recordNetworkDiagnostic('error', 'terminal-recovery-native-failed', {
        sessionId: entry.target.hostSessionId,
        terminalId,
        reason: networkErrorMessage(reason),
      });
      reportStatus(entry.target, 'error', reason, 0);
      for (const waiter of entry.writableWaiters.splice(0)) waiter.reject(new Error(reason));
    };
    const attachment = client.terminal.openTerminal(
      terminalId,
      frame => injectFrame(entry, frame),
      reason => scheduleReconnect(reason || 'Remote terminal closed', true),
      event => {
        if (event.type === 'protocol-state') {
          entry.protocolState = event.state;
          reportProtocolState(entry.target, event.state);
        } else if (event.type === 'clipboard-write') {
          Clipboard.setString(event.text);
        } else if (event.type === 'title') {
          reportTitle(entry.target, event.title);
        }
      },
    );
    entry.controllerAttachment = attachment;
    attachment.then(() => {
      if (entries.current.get(entry.target.key) !== entry) return;
      if (entry.controllerAttachment !== attachment) return;
      if (!entry.controllerAttached) return;
      entry.connecting = false;
      settleResumeConnection(entry);
      reportStatus(entry.target, 'connected', undefined, 0);
      for (const waiter of entry.writableWaiters.splice(0)) waiter.resolve();
      if (
        retained
        && !entry.contentState.hasLiveState
        && entry.target.session.kind !== 'ssh'
      ) {
        entry.frameSequence.reset();
        requestFullFrame(entry);
      }
    }).catch(reason => {
      if (entries.current.get(entry.target.key) !== entry) return;
      if (entry.controllerAttachment !== attachment) return;
      const message = String(reason);
      entry.controllerAttachment = null;
      entry.connecting = false;
      entry.controllerAttached = false;
      reportError(entry.target, message);
      scheduleReconnect(message, false);
    });
  }, [
    injectFrame,
    relinquishController,
    requestFullFrame,
    settleResumeConnection,
  ]);

  const ensureEntry = useCallback((target: TerminalRenderTarget | null | undefined): RendererEntry | null => {
    if (!target) return null;
    let entry = touchTerminalRendererEntry(entries.current, target.key);
    if (!entry) {
      const readinessTrace = beginTerminalRendererReadinessTrace();
      entry = {
        target,
        rendererReady: false,
        sizeReady: false,
        controllerAttached: false,
        controllerAttachment: null,
        connecting: false,
        pendingFrames: [],
        resetOnNextFrame: true,
        contentState: new TerminalRendererContentState(),
        frameSequence: new TerminalFrameSequence(),
        repaintRequested: false,
        fontPreference: preferences.fontSize,
        fontSize: target.session.fontSize ?? preferences.fontSize,
        protocolState: {
          kittyKeyboardReportAll: false,
        },
        alternateScreen: false,
        arbitration: new TerminalArbitration(),
        writableWaiters: [],
        readinessTrace,
      };
      entries.current.set(target.key, entry);
      if (hostReady.current) {
        inject(`window.herdrCreate(${JSON.stringify(target.key)});`);
        configureEntry(entry);
      }
    } else {
      entry.target = target;
    }
    terminalRendererEntryReached(target.session.terminalId);
    connectEntry(entry);
    return entry;
  }, [configureEntry, connectEntry, inject, preferences.fontSize]);

  const activeCall = useCallback((method: string, args: unknown[] = []) => {
    const key = activeKey.current;
    if (!key) return;
    inject(`window.${method}(${[JSON.stringify(key), ...args.map(value => JSON.stringify(value))].join(', ')});`);
  }, [inject]);

  const waitForWritable = useCallback((entry: RendererEntry): Promise<void> => {
    const terminalId = entry.target.session.terminalId;
    if (
      entry.controllerAttached
      && !entry.connecting
      && entry.target.client.terminal.isTerminalBridgeRetained(terminalId)
    ) return Promise.resolve();
    const pending = new Promise<void>((resolve, reject) => {
      entry.writableWaiters.push({ resolve, reject });
    });
    connectEntry(entry);
    return pending;
  }, [connectEntry]);

  const enqueueInput = useCallback((
    entry: RendererEntry,
    operation: () => void | Promise<void>,
    newUserInput = true,
  ) => {
    if (newUserInput) cancelResumeScroll(entry);
    const terminalId = entry.target.session.terminalId;
    const writable = entry.controllerAttached
      && !entry.connecting
      && entry.target.client.terminal.isTerminalBridgeRetained(terminalId);
    const coldWaitTrace: AppPerformanceTrace | null = writable
      ? null
      : beginTerminalColdInputWait();
    return entry.arbitration.queueUserInput({
      newUserInput,
      onActivity: () => {
        connectEntry(entry);
      },
      prepare: async (activity: TerminalInputActivity, dimensions: TerminalDimensions | null) => {
        try {
          await waitForWritable(entry);
        } finally {
          endAppPerformanceTrace(coldWaitTrace);
        }
        if (!activity.reclaimRequired || !dimensions) return;
        await entry.target.client.terminal.resizeTerminal(
          entry.target.session.terminalId,
          dimensions.columns,
          dimensions.rows,
          dimensions.cellWidthPx,
          dimensions.cellHeightPx,
          null,
          // Reassert ownership even when the geometry tuple is unchanged.
          true,
        );
      },
      send: operation,
    }).finally(() => endAppPerformanceTrace(coldWaitTrace));
  }, [cancelResumeScroll, connectEntry, waitForWritable]);

  const reportQueuedInput = useCallback((entry: RendererEntry, data: string) => {
    const target = entry.target.session.status === 'connected'
      ? entry.target
      : {
          ...entry.target,
          session: { ...entry.target.session, status: 'connected' as const },
        };
    return reportInput(target, data);
  }, []);

  useImperativeHandle(forwardedRef, () => ({
    blur: () => activeCall('herdrBlur'),
    cancelPendingResumeScroll: () => {
      const key = activeKey.current;
      const entry = key ? entries.current.get(key) : null;
      if (entry) cancelResumeScroll(entry);
    },
    changeFontSize: delta => activeCall('herdrChangeFontSize', [delta]),
    clearSearch: () => activeCall('herdrClearSearch'),
    fit: () => activeCall('herdrFit'),
    focus: () => {
      webView.current?.requestFocus();
      activeCall('herdrFocus');
    },
    input: data => {
      const key = activeKey.current;
      const entry = key ? entries.current.get(key) : null;
      if (!entry) return false;
      if (
        entry.target.session.status !== 'connected'
        && !entry.arbitration.state.yielded
        && entry.arbitration.state.consecutiveDisplacements === 0
        && isOfflineTerminalNavigationInput(data)
      ) {
        activeCall('herdrOfflineInput', [data]);
        return true;
      }
      enqueueInput(entry, () => reportQueuedInput(entry, data)).catch(
        reason => reportError(entry.target, String(reason)),
      );
      return true;
    },
    paste: data => {
      const key = activeKey.current;
      const entry = key ? entries.current.get(key) : null;
      if (!entry) return;
      if (
        entry.target.session.status !== 'connected'
        && entry.target.session.kind === 'ssh'
      ) return;
      if (entry.target.session.kind === 'ssh') {
        activeCall('herdrPaste', [data]);
        return;
      }
      enqueueInput(entry, () => entry.target.client.native.requestHerdrApi({
        method: 'pane.send_input',
        params: {
          pane_id: entry.target.session.paneId,
          text: prepareTerminalPaste(data),
          keys: [],
        },
      }).then(() => undefined)).catch(
        reason => reportError(entry.target, String(reason)),
      );
    },
    retry: () => {
      const key = activeKey.current;
      const entry = key ? entries.current.get(key) : null;
      if (!entry) return;
      entry.controllerAttached = false;
      entry.controllerAttachment = null;
      entry.connecting = false;
      entry.arbitration.resumeManually();
      entry.target.client.terminal.closeTerminal(entry.target.session.terminalId);
      recordNetworkDiagnostic('info', 'terminal-manual-retry', {
        sessionId: entry.target.hostSessionId,
        terminalId: entry.target.session.terminalId,
      });
      reportStatus(entry.target, 'connecting', undefined, 0);
      connectEntry(entry);
    },
    scanLinks: () => activeCall('herdrScanLinks'),
    scroll: (direction, lines) => activeCall('herdrScroll', [direction, lines]),
    scrollToVisualBottom: () => {
      const key = activeKey.current;
      const entry = key ? entries.current.get(key) : null;
      if (!entry) return;
      cancelResumeScroll(entry);
      const currentViewport = visualViewportRef.current;
      const alternateScreen = currentViewport.alternateScreen === true
        || entry.alternateScreen;
      const currentScroll = currentViewport.scroll || entry.target.scroll;
      if (
        !alternateScreen
        && entry.target.session.kind !== 'ssh'
        && entry.target.session.status === 'connected'
        && currentScroll
        && currentScroll.offset_from_bottom > 0
      ) {
        const lines = Math.max(0, Math.round(currentScroll.offset_from_bottom));
        if (lines > 0) {
          reportScroll(entry.target, 'down', lines);
          entry.target.client.terminal.scrollTerminal(
            entry.target.session.terminalId,
            'down',
            lines,
          ).catch(reason => reportError(entry.target, String(reason)));
        }
      }
      activeCall('herdrScrollToVisualBottom');
    },
    search: (query, caseSensitive, regex, direction) => activeCall(
      'herdrSearch',
      [query, caseSensitive, regex, direction],
    ),
    setForcedMouseInput: enabled => activeCall(
      'herdrSetForcedMouseInput',
      [enabled],
    ),
    setKeyboardEnabled: enabled => {
      if (enabled) webView.current?.requestFocus();
      activeCall('herdrSetKeyboardEnabled', [enabled]);
    },
    submitPastes: (target, parts, newUserInput = true) => {
      const entry = ensureEntry(target);
      if (!entry) return Promise.reject(new Error('Terminal is not available'));
      if (
        entry.target.session.status !== 'connected'
        && entry.target.session.kind === 'ssh'
      ) {
        return Promise.reject(new Error('Terminal is offline and read-only'));
      }
      if (entry.target.session.kind === 'ssh') {
        inject(`window.herdrSubmitPastes(${JSON.stringify(target.key)}, ${JSON.stringify(parts)});`);
        return Promise.resolve();
      }
      const prepared = parts.map(prepareTerminalPaste);
      const inputTrace = beginTerminalInputTrace(entry.target.key, 'submit');
      return enqueueInput(entry, () => withTerminalWriteTrace(
        inputTrace,
        () => entry.target.client.native.submitPastes(
          entry.target.session.paneId,
          [...prepared],
        ),
      ), newUserInput).catch(reason => {
        endTerminalWriteTrace(inputTrace, false);
        reportError(entry.target, String(reason));
        throw reason;
      });
    },
  }), [activeCall, cancelResumeScroll, connectEntry, enqueueInput, ensureEntry, inject, reportQueuedInput]);

  useEffect(() => {
    const valid = new Map(targets.map(target => [target.key, target]));
    for (const [key, target] of knownTargets.current) {
      if (valid.has(key)) continue;
      const entry = entries.current.get(key);
      if (entry) disposeEntry(key, entry, true);
      else {
        target.client.terminal.closeTerminalBridge(target.session.terminalId);
      }
    }
    knownTargets.current = valid;
    for (const [key, entry] of entries.current) {
      const target = valid.get(key);
      if (target) {
        const previousScrollbackMode = terminalScrollbackMode(entry.target.session);
        const nextScrollbackMode = terminalScrollbackMode(target.session);
        entry.target = target;
        if (target.session.status !== 'connected') {
          resumeScrolls.current.delete(key);
        }
        if (
          hostReady.current
          && previousScrollbackMode.offlineScrollback !== nextScrollbackMode.offlineScrollback
        ) {
          configureEntry(entry);
        }
        continue;
      }
      disposeEntry(key, entry, true);
    }
    ensureEntry(activeTarget);
    pruneEntries(new Set(activeTarget?.key ? [activeTarget.key] : []));
  }, [activeTarget, configureEntry, disposeEntry, ensureEntry, pruneEntries, targets]);

  const activeTranscriptKey = activeTarget?.key || '';
  useEffect(() => {
    if (!hostReady.current || !activeTranscriptKey) return;
    const entry = entries.current.get(activeTranscriptKey);
    if (!entry) return;
    syncOfflineTranscript(
      entry,
      offlineTranscript,
      offlineScrollRef.current,
    );
  }, [
    activeTranscriptKey,
    offlineTranscript,
    syncOfflineTranscript,
  ]);

  useEffect(() => {
    for (const entry of entries.current.values()) {
      if (entry.fontPreference !== preferences.fontSize) {
        entry.fontPreference = preferences.fontSize;
        entry.fontSize = preferences.fontSize;
        reportFontSize(entry.target, entry.fontSize);
      }
      if (hostReady.current) configureEntry(entry);
    }
  }, [configureEntry, preferences]);

  const visualTopInset = visualViewport.insets.top;
  const visualBottomInset = visualViewport.insets.bottom;
  const visualGeometryBottomInset = visualViewport.geometryBottomInset;
  const visualAlternateScreen = visualViewport.alternateScreen;
  const visualScrollOffset = visualViewport.scroll?.offset_from_bottom;
  const visualMaxScrollOffset = visualViewport.scroll?.max_offset_from_bottom;
  useEffect(() => {
    if (!hostReady.current || !activeTarget) return;
    inject(`window.herdrSetVisualInsets(${JSON.stringify(activeTarget.key)}, ${JSON.stringify({
      top: visualTopInset,
      bottom: visualBottomInset,
      geometryBottomInset: visualGeometryBottomInset,
      debug: preferences.visualHints,
      alternateScreen: visualAlternateScreen,
      scrollOffsetFromBottom: visualScrollOffset,
      maxScrollOffsetFromBottom: visualMaxScrollOffset,
    })});`);
  }, [
    activeTarget,
    inject,
    visualBottomInset,
    visualAlternateScreen,
    visualGeometryBottomInset,
    visualMaxScrollOffset,
    visualScrollOffset,
    visualTopInset,
    preferences.visualHints,
  ]);

  useEffect(() => {
    if (!hostReady.current) return;
    if (!activeTarget) return;
    if (!visible) {
      // Keep only the selected terminal presented and composited behind the
      // foreground app screen. Other cached xterm sessions remain hidden.
      inject(`window.herdrActivate(${JSON.stringify(activeTarget.key)}); window.herdrBlur(${JSON.stringify(activeTarget.key)});`);
      return;
    }
    inject(`window.herdrActivate(${JSON.stringify(activeTarget.key)});`);
  }, [activeTarget, inject, visible]);

  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', state => {
      const wasActive = previous === 'active';
      previous = state;
      appState.current = state;
      if (state !== 'active') {
        if (wasActive && hostReady.current) {
          for (const entry of entries.current.values()) {
            if (
              entry.target.session.kind !== 'ssh'
              && entry.contentState.hasRenderedState
            ) {
              inject(`window.herdrSnapshot(${JSON.stringify(entry.target.key)}, "background");`);
            }
          }
        }
        if (wasActive) {
          // Release Herdr's resize lock, preserving Chat and the host connection.
          resumeScrolls.current.clear();
          for (const entry of entries.current.values()) {
            const activeViewport = entry.target.key === activeKey.current
              ? visualViewportRef.current
              : undefined;
            const scroll = activeViewport?.scroll || entry.target.scroll;
            const alternateScreen =
              activeViewport?.alternateScreen === true || entry.alternateScreen;
            if (
              entry.target.session.kind !== 'ssh'
              && entry.target.session.status === 'connected'
              && scroll
              && !alternateScreen
            ) {
              resumeScrolls.current.set(entry.target.key, {
                checkpoint: {
                  offsetFromBottom: scroll.offset_from_bottom,
                  maxOffsetFromBottom: scroll.max_offset_from_bottom,
                },
                connectionSettled: false,
                finalResizeSettled: false,
                restoring: false,
              });
            }
            if (entry.target.session.kind !== 'ssh') {
              relinquishController(entry, true);
            }
          }
          // Evicted renderers can still have warm native bridges holding locks.
          for (const [key, target] of knownTargets.current) {
            if (
              !entries.current.has(key)
              && target.session.kind !== 'ssh'
              && target.client.terminal.isTerminalBridgeRetained(target.session.terminalId)
            ) {
              target.client.terminal.closeTerminalBridge(target.session.terminalId);
            }
          }
        }
        return;
      }
      if (wasActive) return;
      for (const [key, resume] of resumeScrolls.current) {
        const entry = entries.current.get(key);
        if (
          !entry
          || entry.target.session.kind === 'ssh'
          || entry.target.session.status !== 'connected'
          || entry.alternateScreen
        ) {
          resumeScrolls.current.delete(key);
          continue;
        }
        resume.connectionSettled = false;
        resume.finalResizeSettled = !(
          hostReady.current
          && visible
          && key === activeKey.current
        );
        resume.restoring = false;
      }
      for (const entry of entries.current.values()) {
        if (entry.connecting) continue;
        if (
          !entry.controllerAttached
          || !entry.target.client.terminal.isTerminalBridgeRetained(entry.target.session.terminalId)
        ) {
          relinquishController(entry, false);
          connectEntry(entry);
        } else {
          settleResumeConnection(entry);
        }
      }
      const activeEntry = activeKey.current ? entries.current.get(activeKey.current) : null;
      if (
        visible && activeEntry
        && (preferences.pauseResizeInBackground || activeEntry.target.session.kind !== 'ssh')
      ) {
        inject(`window.herdrFit(${JSON.stringify(activeKey.current)});`);
      }
    });
    return () => subscription.remove();
  }, [
    connectEntry,
    inject,
    preferences.pauseResizeInBackground,
    relinquishController,
    settleResumeConnection,
    visible,
  ]);

  useEffect(() => () => {
    resumeScrolls.current.clear();
    for (const entry of entries.current.values()) {
      if (
        hostReady.current
        && entry.target.session.kind !== 'ssh'
        && entry.contentState.hasRenderedState
      ) {
        inject(`window.herdrSnapshot(${JSON.stringify(entry.target.key)}, "detach");`);
      }
      relinquishController(entry, false);
    }
    for (const trace of serializationTraces.current.values()) {
      endAppPerformanceTrace(trace);
    }
    serializationTraces.current.clear();
    entries.current.clear();
  }, [inject, relinquishController]);

  const handleMessage = async (event: WebViewMessageEvent) => {
    const message = parseTerminalWebMessage(event.nativeEvent.data);
    if (!message) return;
    if (message.type === 'ready') {
      const reloaded = hostReady.current;
      hostReady.current = true;
      for (const entry of entries.current.values()) {
        if (reloaded) {
          entry.rendererReady = false;
          entry.sizeReady = false;
          entry.resetOnNextFrame = true;
          entry.contentState = new TerminalRendererContentState();
          entry.frameSequence.reset();
          entry.repaintRequested = false;
        }
        inject(`window.herdrCreate(${JSON.stringify(entry.target.key)});`);
        configureEntry(entry);
      }
      if (visible && activeKey.current) {
        inject(`window.herdrActivate(${JSON.stringify(activeKey.current)});`);
      }
      const entry = activeKey.current ? entries.current.get(activeKey.current) : null;
      if (entry) syncOfflineTranscript(
        entry,
        offlineTranscriptRef.current,
        offlineScrollRef.current,
      );
      reportReady();
      return;
    }
    if (message.type === 'cache-snapshot-start' && typeof message.key === 'string') {
      endAppPerformanceTrace(serializationTraces.current.get(message.key) || null);
      const trace = beginAppPerformanceTrace('Whip terminal offline cache serialize');
      if (trace) serializationTraces.current.set(message.key, trace);
      else serializationTraces.current.delete(message.key);
      return;
    }
    if (message.type === 'cache-snapshot' && typeof message.key === 'string') {
      endAppPerformanceTrace(serializationTraces.current.get(message.key) || null);
      serializationTraces.current.delete(message.key);
      if (typeof message.transcript === 'string') {
        reportOfflineSnapshot(message.key, message.transcript);
      }
      return;
    }
    if (message.type === 'trace-write-received') {
      if (isInteger(message.inboundCookie)) {
        terminalInboundWebViewReceived(message.inboundCookie);
      }
      return;
    }
    if (message.type === 'trace-xterm-written') {
      if (isInteger(message.inboundCookie)) {
        terminalInboundXtermWritten(message.inboundCookie);
      }
      return;
    }
    if (message.type === 'trace-rendered') {
      if (isInteger(message.inputCookie)) terminalFrameRendered(message.inputCookie);
      else if (isInteger(message.cookie)) terminalFrameRendered(message.cookie);
      if (isInteger(message.resizeCookie)) {
        terminalResizeFrameRendered(message.resizeCookie);
      }
      if (isInteger(message.inboundCookie)) {
        terminalInboundFrameVisible(message.inboundCookie);
      }
      return;
    }
    const entry = typeof message.key === 'string' ? entries.current.get(message.key) : null;
    if (!entry) return;
    if (message.type === 'terminal-ready') {
      entry.rendererReady = true;
      terminalRendererBecameReady(entry.readinessTrace);
      const frames = entry.pendingFrames;
      entry.pendingFrames = [];
      for (const pending of frames) injectFrame(
        entry,
        pending.frame,
        pending.inputTraceCookie,
        pending.resizeTraceCookie,
      );
      if (entry.target.key === activeKey.current) {
        syncOfflineTranscript(
          entry,
          offlineTranscriptRef.current,
          offlineScrollRef.current,
        );
      }
      if (
        entry.controllerAttached
        && !entry.contentState.hasLiveState
        && entry.target.session.kind !== 'ssh'
      ) {
        requestFullFrame(entry);
      }
      connectEntry(entry);
      return;
    }
    if (message.type === 'input') {
      const data = message.data;
      if (typeof data !== 'string') return;
      await enqueueInput(entry, () => reportQueuedInput(entry, data));
    } else if (message.type === 'buffered-submit') {
      const inputTrace = beginTerminalInputTrace(entry.target.key, 'submit');
      try {
        const pastedParts = stringArray(message.parts);
        await enqueueInput(entry, async () => {
          for (const [index, data] of terminalSubmissionWrites(pastedParts).entries()) {
            if (index === 0) {
              await withTerminalWriteTrace(
                inputTrace,
                () => inputTrace
                  ? entry.target.client.terminal.writeToTerminal(
                    entry.target.session.terminalId,
                    data,
                    inputTrace,
                  )
                  : entry.target.client.terminal.writeToTerminal(entry.target.session.terminalId, data),
              );
            } else {
              await entry.target.client.terminal.writeToTerminal(
                entry.target.session.terminalId,
                data,
              );
            }
          }
        });
      } catch (reason) {
        endTerminalWriteTrace(inputTrace, false);
        reportError(entry.target, String(reason));
      }
    } else if (message.type === 'resize') {
      if (
        !isFiniteNumber(message.cols)
        || !isFiniteNumber(message.rows)
        || !isFiniteNumber(message.cellWidthPx)
        || !isFiniteNumber(message.cellHeightPx)
      ) return;
      const source = message.source === 'fit' ? 'fit' : 'xterm';
      const resume = source === 'fit'
        ? resumeScrolls.current.get(entry.target.key)
        : undefined;
      const resizeTrace = beginTerminalResizeTrace(
        entry.target.key,
        source,
        message.cols,
        message.rows,
        message.cellWidthPx,
        message.cellHeightPx,
        isFiniteNumber(message.localFitMs) ? message.localFitMs : undefined,
        isFiniteNumber(message.requestedAtEpochMs)
          ? Date.now() - message.requestedAtEpochMs
          : undefined,
      );
      try {
        const dimensions = {
          columns: message.cols,
          rows: message.rows,
          cellWidthPx: message.cellWidthPx,
          cellHeightPx: message.cellHeightPx,
        };
        entry.arbitration.cacheDimensions(dimensions);
        entry.sizeReady = true;
        terminalRendererSizeBecameReady(entry.readinessTrace);
        if (!entry.arbitration.shouldSendResize()) {
          terminalResizeRequestReady(resizeTrace);
          abandonTerminalResizeTrace(resizeTrace);
          return;
        }
        if (
          appState.current !== 'active'
          && (preferences.pauseResizeInBackground || entry.target.session.kind !== 'ssh')
        ) {
          terminalResizeRequestReady(resizeTrace);
          abandonTerminalResizeTrace(resizeTrace);
          return;
        }
        terminalResizeRequestReady(resizeTrace);
        await entry.target.client.terminal.resizeTerminal(
          entry.target.session.terminalId,
          dimensions.columns,
          dimensions.rows,
          dimensions.cellWidthPx,
          dimensions.cellHeightPx,
          resizeTrace,
          // A fit is also a redraw/reflow signal after presenting a terminal,
          // even when its geometry tuple matches the last native resize.
          terminalResizeForcesNativeDispatch(source),
        );
        settleResumeResize(entry, resume);
        connectEntry(entry);
      } finally {
        terminalResizeRequestReady(resizeTrace);
        terminalResizeRequestHandled(resizeTrace);
      }
    } else if (message.type === 'scroll') {
      if (
        (message.direction !== 'up' && message.direction !== 'down')
        || !isFiniteNumber(message.lines)
      ) return;
      if (
        entry.target.session.status !== 'connected'
        || entry.arbitration.state.yielded
      ) return;
      cancelResumeScroll(entry);
      reportScroll(entry.target, message.direction, message.lines);
      try {
        await entry.target.client.terminal.scrollTerminal(
          entry.target.session.terminalId,
          message.direction,
          message.lines,
          isFiniteNumber(message.column) ? message.column : undefined,
          isFiniteNumber(message.row) ? message.row : undefined,
        );
      } catch (reason) {
        reportError(entry.target, String(reason));
      }
    } else if (message.type === 'offline-scroll') {
      if (
        !isFiniteNumber(message.offsetFromBottom)
        || !isFiniteNumber(message.maxOffsetFromBottom)
        || !isFiniteNumber(message.viewportRows)
      ) return;
      if (
        entry.target.session.kind === 'ssh'
        || !terminalScrollbackMode(entry.target.session).offlineScrollback
      ) return;
      reportOfflineScroll(entry.target, {
        offset_from_bottom: message.offsetFromBottom,
        max_offset_from_bottom: message.maxOffsetFromBottom,
        viewport_rows: message.viewportRows,
      });
    } else if (message.type === 'font-size-change') {
      const fontSize = Number(message.fontSize);
      if (Number.isFinite(fontSize)) {
        entry.fontSize = Math.max(8, Math.min(24, Math.round(fontSize)));
        reportFontSize(entry.target, entry.fontSize);
      }
    } else if (message.type === 'buffer-mode') {
      entry.alternateScreen = message.alternate === true;
      if (entry.alternateScreen) cancelResumeScroll(entry);
      reportBufferMode(entry.target, entry.alternateScreen);
    } else if (message.type === 'visual-scroll-state') {
      if (typeof message.atVisualBottom !== 'boolean') return;
      reportVisualScrollState(entry.target, message.atVisualBottom);
    } else if (message.type === 'visual-insets-debug') {
      console.info('[WHIP_TERMINAL_VISUAL]', JSON.stringify({
        key: entry.target.key,
        alternateScreen: message.alternateScreen,
        top: message.top,
        bottom: message.bottom,
        geometryBottom: message.geometryBottom,
        offset: message.offset,
        maximum: message.maximum,
        visualOffset: message.visualOffset,
        boundary: message.boundary,
        boundaryRevealPx: message.boundaryRevealPx,
        remoteScroll: message.remoteScroll,
        inputOffset: message.inputOffset,
        pendingDelta: message.pendingDelta,
      }));
    } else if (message.type === 'clipboard-write') {
      Clipboard.setString(typeof message.text === 'string' ? message.text : '');
    } else if (message.type === 'clipboard-read') {
      if (
        entry.target.session.status !== 'connected'
        && entry.target.session.kind === 'ssh'
      ) return;
      const value = await Clipboard.getString();
      if (value) {
        if (entry.target.session.kind === 'ssh') {
          inject(`window.herdrPaste(${JSON.stringify(entry.target.key)}, ${JSON.stringify(value)});`);
        } else {
          enqueueInput(entry, () => entry.target.client.native.requestHerdrApi({
            method: 'pane.send_input',
            params: {
              pane_id: entry.target.session.paneId,
              text: prepareTerminalPaste(value),
              keys: [],
            },
          }).then(() => undefined)).catch(
            reason => reportError(entry.target, String(reason)),
          );
        }
        reportPaste(entry.target, value);
      }
    } else if (entry.target.key === activeKey.current && message.type === 'search-result') {
      if (!isFiniteNumber(message.count) || !isFiniteNumber(message.index)) return;
      reportSearch(message.count, message.index, message.invalid === true);
    } else if (entry.target.key === activeKey.current && message.type === 'link-scan-result') {
      reportLinks(stringArray(message.links));
    } else if (
      entry.target.key === activeKey.current
      && message.type === 'open-link'
      && typeof message.link === 'string'
    ) {
      reportOpenLink(message.link);
    }
  };

  return (
    <WebView
      ref={value => {
        webView.current = value;
      }}
      source={TERMINAL_SOURCE}
      originWhitelist={['file://*', 'about:blank', 'data:*']}
      allowFileAccess
      allowingReadAccessToURL={Platform.OS === 'ios'
        ? IOS_TERMINAL_ASSET_DIRECTORY
        : undefined}
      javaScriptEnabled
      textZoom={100}
      onMessage={handleMessage}
      onTouchStart={() => {
        if (!visible || !activeKey.current) return;
        const entry = entries.current.get(activeKey.current);
        if (entry) cancelResumeScroll(entry);
        webView.current?.requestFocus();
        activeCall('herdrFocus');
      }}
      style={style}
      containerStyle={WEBVIEW_CONTAINER_STYLE}
    />
  );
});
