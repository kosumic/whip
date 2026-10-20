import { NativeModules, Platform } from 'react-native';

type PerformanceTraceNativeModule = {
  beginAsyncSection: (name: string, cookie: number) => boolean;
  endAsyncSection: (name: string, cookie: number) => boolean;
  setCounter?: (name: string, value: number) => boolean;
};

const performanceTrace = NativeModules.WhipPerformanceTrace as
  | PerformanceTraceNativeModule
  | undefined;
let nextCookie = 1;

const INPUT_TO_WRITE = 'Whip terminal input to native dispatch';
const INPUT_TO_FRAME = 'Whip terminal input to first frame';
const INPUT_TO_VISIBLE = 'Whip terminal input to visible';
const FRAME_TO_VISIBLE = 'Whip terminal frame to visible';
const PRE_NATIVE_WAIT = 'Whip terminal app pre-native wait';
const NATIVE_ENQUEUE = 'Whip terminal native enqueue';
const NATIVE_QUEUE_TO_RESPONSE = 'Whip terminal native queue to response';
const NATIVE_RESPONSE_TO_RENDERER = 'Whip terminal native response to renderer';
const INBOUND_FRAME_TO_VISIBLE = 'Whip terminal inbound frame to visible';
const INBOUND_JS_RECEIVE = 'Whip terminal inbound JS receive';
const INBOUND_JS_DECODE = 'Whip terminal inbound JS decode';
const INBOUND_RENDERER_DISPATCH = 'Whip terminal inbound renderer dispatch';
const INBOUND_RENDERER_PREPARATION = 'Whip terminal inbound renderer preparation';
const INBOUND_BASE64_ENCODING = 'Whip terminal inbound base64 encoding';
const INBOUND_SCRIPT_BUILD = 'Whip terminal inbound script build';
const INBOUND_FRAME_BYTES = 'Whip terminal inbound frame bytes';
const INBOUND_WEBVIEW_INJECTION = 'Whip terminal inbound WebView injection';
const INBOUND_WEBVIEW_DELIVERY = 'Whip terminal inbound WebView delivery';
const INBOUND_XTERM_WRITE = 'Whip terminal inbound xterm write';
const INBOUND_XTERM_TO_VISIBLE = 'Whip terminal inbound xterm to visible';
const TAB_SELECTION_TO_RENDERER = 'Whip terminal tab selection to renderer entry';
const RENDERER_READINESS = 'Whip terminal renderer readiness';
const RENDERER_XTERM_READY = 'Whip terminal xterm creation';
const RENDERER_INITIAL_SIZE = 'Whip terminal initial size measurement';
const COLD_INPUT_TO_WRITABLE = 'Whip terminal cold input to writable';
const RESIZE_REQUEST = 'Whip terminal resize request';
const RESIZE_WAIT_FOR_WRITABLE = 'Whip terminal resize wait for writable';
const RESIZE_NATIVE_DISPATCH = 'Whip terminal resize native dispatch';
const RESIZE_TO_FIRST_FRAME = 'Whip terminal resize to first frame';
const RESIZE_FRAME_TO_VISIBLE = 'Whip terminal resize frame to visible';
const RESIZE_TO_VISIBLE = 'Whip terminal resize to visible';
const RESIZE_SUPERSEDED = 'Whip terminal resize superseded';
const RESIZE_DEDUPLICATED = 'Whip terminal resize deduplicated';
const TRACE_TIMEOUT_MS = 10_000;
const INBOUND_TRACE_DISABLED_POLL_MS = 1_000;

export type AppPerformanceTrace = {
  name: string;
  cookie: number;
  ended: boolean;
};

export type TerminalInputTrace = {
  targetKey: string;
  writeCookie: number;
  frameCookie: number;
  visibleCookie: number;
  frameToVisibleCookie: number | null;
  preNativeWaitCookie: number | null;
  nativeEnqueueCookie: number | null;
  nativeQueueToResponseCookie: number | null;
  nativeResponseToRendererCookie: number | null;
  writeEnded: boolean;
  frameReceived: boolean;
  nativeResponseReceived: boolean;
  visibleEnded: boolean;
  timeout: ReturnType<typeof setTimeout>;
};

export type TerminalRendererReadinessTrace = {
  readiness: AppPerformanceTrace;
  xtermCookie: number;
  sizeCookie: number;
  rendererReady: boolean;
  sizeReady: boolean;
};

export type TerminalResizeTrace = {
  targetKey: string;
  request: AppPerformanceTrace;
  sourceName: string;
  sourceCookie: number;
  waitCookie: number | null;
  nativeCookie: number | null;
  firstFrameCookie: number | null;
  visibleCookie: number | null;
  frameToVisibleCookie: number | null;
  queuedForFrame: boolean;
  ended: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
};

const pendingByTarget = new Map<string, TerminalInputTrace[]>();
const pendingByVisibleCookie = new Map<number, TerminalInputTrace>();
const pendingTabSelections = new Map<string, AppPerformanceTrace>();
const pendingResizeByTarget = new Map<string, TerminalResizeTrace[]>();
const pendingResizeByVisibleCookie = new Map<number, TerminalResizeTrace>();
let resizeEventSequence = 0;

type TerminalInboundTrace = {
  cookie: number;
  active: Set<string>;
  timeout: ReturnType<typeof setTimeout>;
  injectedAt?: number;
};

const pendingInboundTraces = new Map<number, TerminalInboundTrace>();
let inboundTraceEnabled = false;
let nextInboundTraceProbeAt = 0;

function nextTraceCookie(): number {
  const cookie = nextCookie;
  nextCookie = nextCookie >= 0x7fffffff ? 1 : nextCookie + 1;
  return cookie;
}

function beginAsyncEvent(name: string, cookie = nextTraceCookie()): number {
  performanceTrace?.beginAsyncSection(name, cookie);
  return cookie;
}

function endAsyncEvent(name: string, cookie: number): void {
  performanceTrace?.endAsyncSection(name, cookie);
}

function beginInboundStage(trace: TerminalInboundTrace, name: string): void {
  if (trace.active.has(name)) return;
  trace.active.add(name);
  beginAsyncEvent(name, trace.cookie);
}

function endInboundStage(trace: TerminalInboundTrace, name: string): void {
  if (!trace.active.delete(name)) return;
  endAsyncEvent(name, trace.cookie);
}

function finishTerminalInboundTrace(cookie: number): void {
  const trace = pendingInboundTraces.get(cookie);
  if (!trace) return;
  for (const name of trace.active) endAsyncEvent(name, cookie);
  trace.active.clear();
  pendingInboundTraces.delete(cookie);
  clearTimeout(trace.timeout);
}

/** First JS instruction reached by a typed UniFFI Unix-socket data callback. */
export function terminalInboundJsReceived(): number | null {
  if (Platform.OS !== 'android' || !performanceTrace) return null;
  if (!inboundTraceEnabled) {
    const now = Date.now();
    if (now < nextInboundTraceProbeAt) return null;
    nextInboundTraceProbeAt = now + INBOUND_TRACE_DISABLED_POLL_MS;
  }
  const cookie = nextTraceCookie();
  if (!performanceTrace.beginAsyncSection(INBOUND_FRAME_TO_VISIBLE, cookie)) {
    inboundTraceEnabled = false;
    return null;
  }
  inboundTraceEnabled = true;
  const trace = {
    cookie,
    active: new Set<string>([INBOUND_FRAME_TO_VISIBLE]),
    timeout: undefined as unknown as ReturnType<typeof setTimeout>,
  } satisfies TerminalInboundTrace;
  pendingInboundTraces.set(cookie, trace);
  beginInboundStage(trace, INBOUND_JS_RECEIVE);
  endInboundStage(trace, INBOUND_JS_RECEIVE);
  beginInboundStage(trace, INBOUND_JS_DECODE);
  trace.timeout = setTimeout(() => finishTerminalInboundTrace(cookie), TRACE_TIMEOUT_MS);
  return cookie;
}

/** Ends codec work and starts the synchronous dispatch toward the renderer. */
export function terminalInboundDecodeComplete(cookie: number | null): void {
  if (cookie === null) return;
  const trace = pendingInboundTraces.get(cookie);
  if (!trace) return;
  endInboundStage(trace, INBOUND_JS_DECODE);
  beginInboundStage(trace, INBOUND_RENDERER_DISPATCH);
}

/** Called at TerminalRendererHost's first instruction for the decoded frame. */
export function terminalInboundRendererReceived(
  cookie: number | null,
  frameByteLength: number,
): void {
  if (cookie === null) return;
  const trace = pendingInboundTraces.get(cookie);
  if (!trace) return;
  endInboundStage(trace, INBOUND_RENDERER_DISPATCH);
  beginInboundStage(trace, INBOUND_RENDERER_PREPARATION);
  performanceTrace?.setCounter?.(INBOUND_FRAME_BYTES, frameByteLength);
}

export function terminalInboundBase64Started(cookie: number | null): void {
  if (cookie === null) return;
  const trace = pendingInboundTraces.get(cookie);
  if (trace) beginInboundStage(trace, INBOUND_BASE64_ENCODING);
}

export function terminalInboundBase64Ended(cookie: number | null): void {
  if (cookie === null) return;
  const trace = pendingInboundTraces.get(cookie);
  if (trace) endInboundStage(trace, INBOUND_BASE64_ENCODING);
}

export function terminalInboundScriptBuildStarted(cookie: number | null): void {
  if (cookie === null) return;
  const trace = pendingInboundTraces.get(cookie);
  if (trace) beginInboundStage(trace, INBOUND_SCRIPT_BUILD);
}

export function terminalInboundScriptBuildEnded(cookie: number | null): void {
  if (cookie === null) return;
  const trace = pendingInboundTraces.get(cookie);
  if (trace) endInboundStage(trace, INBOUND_SCRIPT_BUILD);
}

/** Starts the exact injectJavaScript call and the wait for WebView receipt. */
export function terminalInboundWebViewInjectionStarted(cookie: number | null): void {
  if (cookie === null) return;
  const trace = pendingInboundTraces.get(cookie);
  if (!trace) return;
  trace.injectedAt = Date.now();
  endInboundStage(trace, INBOUND_RENDERER_PREPARATION);
  beginInboundStage(trace, INBOUND_WEBVIEW_INJECTION);
  beginInboundStage(trace, INBOUND_WEBVIEW_DELIVERY);
}

/** Ends the synchronous React Native WebView injection call. */
export function terminalInboundWebViewInjectionEnded(cookie: number | null): void {
  if (cookie === null) return;
  const trace = pendingInboundTraces.get(cookie);
  if (trace) endInboundStage(trace, INBOUND_WEBVIEW_INJECTION);
}

/** Acknowledges entry into herdrWrite/herdrWriteBase64Chunk inside WebView. */
export function terminalInboundWebViewReceived(cookie: number, sentAt?: number): void {
  const trace = pendingInboundTraces.get(cookie);
  if (!trace) return;
  if (sentAt !== undefined && trace.injectedAt !== undefined) {
    performanceTrace?.setCounter?.('Whip terminal WebView delivery us', Math.max(0, sentAt - trace.injectedAt) * 1000);
  }
  recordWebViewTiming('receive', sentAt);
  endInboundStage(trace, INBOUND_WEBVIEW_DELIVERY);
  beginInboundStage(trace, INBOUND_XTERM_WRITE);
}

/** Acknowledges xterm.write's completion callback inside WebView. */
export function terminalInboundXtermWritten(cookie: number, sentAt?: number, writeMs?: number, base64Ms?: number): void {
  const trace = pendingInboundTraces.get(cookie);
  if (!trace) return;
  recordWebViewTiming('write', sentAt, writeMs);
  recordWebViewTiming('base64', undefined, base64Ms);
  endInboundStage(trace, INBOUND_XTERM_WRITE);
  beginInboundStage(trace, INBOUND_XTERM_TO_VISIBLE);
}

/** Ends after the existing pair of requestAnimationFrame callbacks. */
export function terminalInboundFrameVisible(cookie: number, sentAt?: number, visibleMs?: number): void {
  const trace = pendingInboundTraces.get(cookie);
  if (!trace) return;
  recordWebViewTiming('visible', sentAt, visibleMs);
  endInboundStage(trace, INBOUND_XTERM_TO_VISIBLE);
  finishTerminalInboundTrace(cookie);
}

function recordWebViewTiming(phase: string, sentAt?: number, localMs?: number): void {
  if (sentAt !== undefined) {
    performanceTrace?.setCounter?.(`Whip terminal WebView ${phase} callback queue us`, Math.max(0, Date.now() - sentAt) * 1000);
  }
  if (localMs !== undefined) {
    performanceTrace?.setCounter?.(`Whip terminal WebView ${phase} local us`, Math.max(0, Math.round(localMs * 1000)));
  }
}

/** Ends a trace for a non-terminal/control frame or a frame that cannot be delivered. */
export function abandonTerminalInboundTrace(cookie: number | null): void {
  if (cookie !== null) finishTerminalInboundTrace(cookie);
}

type TerminalInboundGlobal = typeof globalThis & {
  __whipTerminalInboundTrace?: {
    jsReceived: () => number | null;
    decodeComplete: (cookie: number | null) => void;
    abandon: (cookie: number | null) => void;
  };
  __whipHerdrPerformanceTrace?: {
    begin: (name: string) => AppPerformanceTrace | null;
    end: (trace: AppPerformanceTrace | null) => void;
  };
};

// The generated Whip core bindings cannot import app services.
// This no-op-when-absent hook preserves that dependency boundary while placing
// the first JS marker at the generated UniFFI callback's immediate consumer.
(globalThis as TerminalInboundGlobal).__whipTerminalInboundTrace = {
  jsReceived: terminalInboundJsReceived,
  decodeComplete: terminalInboundDecodeComplete,
  abandon: abandonTerminalInboundTrace,
};

/** Starts an app-owned async slice that is emitted only during an Android trace. */
export function beginAppPerformanceTrace(name: string): AppPerformanceTrace | null {
  if (Platform.OS !== 'android' || !performanceTrace) return null;
  const cookie = nextTraceCookie();
  if (!performanceTrace.beginAsyncSection(name, cookie)) return null;
  return { name, cookie, ended: false };
}

/** Ends an app-owned async slice. Repeated calls are intentionally harmless. */
export function endAppPerformanceTrace(trace: AppPerformanceTrace | null): void {
  if (!trace || trace.ended) return;
  trace.ended = true;
  performanceTrace?.endAsyncSection(trace.name, trace.cookie);
}

// The private SSH adapter cannot import app services. This trace-only hook keeps
// channel/handshake markers optional and allocation-free when native tracing is off.
(globalThis as TerminalInboundGlobal).__whipHerdrPerformanceTrace = {
  begin: beginAppPerformanceTrace,
  end: endAppPerformanceTrace,
};

export async function withAppPerformanceTrace<Result>(
  name: string,
  operation: () => Result | Promise<Result>,
): Promise<Result> {
  const trace = beginAppPerformanceTrace(name);
  try {
    return await operation();
  } finally {
    endAppPerformanceTrace(trace);
  }
}

/** Begins at the tab-selection state update and ends when its renderer entry is reached. */
export function terminalTabSelectionStarted(terminalId: string): void {
  const trace = beginAppPerformanceTrace(TAB_SELECTION_TO_RENDERER);
  if (!trace) return;
  endAppPerformanceTrace(pendingTabSelections.get(terminalId) || null);
  pendingTabSelections.set(terminalId, trace);
}

export function terminalRendererEntryReached(terminalId: string): void {
  const trace = pendingTabSelections.get(terminalId) || null;
  if (!trace) return;
  pendingTabSelections.delete(terminalId);
  endAppPerformanceTrace(trace);
}

/** Cold-only renderer entry timing; no object is allocated while tracing is disabled. */
export function beginTerminalRendererReadinessTrace(): TerminalRendererReadinessTrace | null {
  const readiness = beginAppPerformanceTrace(RENDERER_READINESS);
  if (!readiness) return null;
  return {
    readiness,
    xtermCookie: beginAsyncEvent(RENDERER_XTERM_READY),
    sizeCookie: beginAsyncEvent(RENDERER_INITIAL_SIZE),
    rendererReady: false,
    sizeReady: false,
  };
}

function maybeEndRendererReadiness(trace: TerminalRendererReadinessTrace | null): void {
  if (trace?.rendererReady && trace.sizeReady) endAppPerformanceTrace(trace.readiness);
}

export function terminalRendererBecameReady(
  trace: TerminalRendererReadinessTrace | null,
): void {
  if (!trace || trace.rendererReady) return;
  trace.rendererReady = true;
  endAsyncEvent(RENDERER_XTERM_READY, trace.xtermCookie);
  maybeEndRendererReadiness(trace);
}

export function terminalRendererSizeBecameReady(
  trace: TerminalRendererReadinessTrace | null,
): void {
  if (!trace || trace.sizeReady) return;
  trace.sizeReady = true;
  endAsyncEvent(RENDERER_INITIAL_SIZE, trace.sizeCookie);
  maybeEndRendererReadiness(trace);
}

export function abandonTerminalRendererReadinessTrace(
  trace: TerminalRendererReadinessTrace | null,
): void {
  if (!trace) return;
  if (!trace.rendererReady) endAsyncEvent(RENDERER_XTERM_READY, trace.xtermCookie);
  if (!trace.sizeReady) endAsyncEvent(RENDERER_INITIAL_SIZE, trace.sizeCookie);
  endAppPerformanceTrace(trace.readiness);
}

export function beginTerminalColdInputWait(): AppPerformanceTrace | null {
  return beginAppPerformanceTrace(COLD_INPUT_TO_WRITABLE);
}

function resizeDetailName(
  source: 'fit' | 'xterm',
  columns: number,
  rows: number,
  cellWidthPx: number,
  cellHeightPx: number,
  localFitMs?: number,
  webViewQueueMs?: number,
): string {
  resizeEventSequence += 1;
  const local = source === 'fit' && Number.isFinite(localFitMs)
    ? ` local-fit=${Math.max(0, localFitMs || 0).toFixed(2)}ms`
    : '';
  const queue = Number.isFinite(webViewQueueMs)
    ? ` webview-queue=${Math.max(0, webViewQueueMs || 0).toFixed(1)}ms`
    : '';
  return `Whip terminal resize event: #${resizeEventSequence} ${source} ${columns}x${rows} cell=${cellWidthPx}x${cellHeightPx}${local}${queue}`;
}

/** Begins when TerminalRendererHost receives an xterm/fit resize message. */
export function beginTerminalResizeTrace(
  targetKey: string,
  source: 'fit' | 'xterm',
  columns: number,
  rows: number,
  cellWidthPx: number,
  cellHeightPx: number,
  localFitMs?: number,
  webViewQueueMs?: number,
): TerminalResizeTrace | null {
  const request = beginAppPerformanceTrace(RESIZE_REQUEST);
  if (!request) return null;
  const sourceName = `Whip terminal resize: ${source}`;
  const sourceCookie = beginAsyncEvent(sourceName);
  const detailName = resizeDetailName(
    source,
    columns,
    rows,
    cellWidthPx,
    cellHeightPx,
    localFitMs,
    webViewQueueMs,
  );
  const detailCookie = beginAsyncEvent(detailName);
  endAsyncEvent(detailName, detailCookie);
  return {
    targetKey,
    request,
    sourceName,
    sourceCookie,
    waitCookie: null,
    nativeCookie: null,
    firstFrameCookie: null,
    visibleCookie: null,
    frameToVisibleCookie: null,
    queuedForFrame: false,
    ended: false,
    timeout: null,
  };
}

/** Ends immediately before Whip attempts (or deliberately declines) the resize. */
export function terminalResizeRequestReady(trace: TerminalResizeTrace | null): void {
  if (trace) endAppPerformanceTrace(trace.request);
}

/** Preserves the existing fit/xterm operation duration and source distinction. */
export function terminalResizeRequestHandled(trace: TerminalResizeTrace | null): void {
  if (!trace) return;
  endAsyncEvent(trace.sourceName, trace.sourceCookie);
}

export function terminalResizeWaitStarted(trace: TerminalResizeTrace | null): void {
  if (!trace || trace.ended || trace.waitCookie !== null) return;
  trace.waitCookie = beginAsyncEvent(RESIZE_WAIT_FOR_WRITABLE);
}

function endTerminalResizeWait(trace: TerminalResizeTrace): void {
  if (trace.waitCookie === null) return;
  endAsyncEvent(RESIZE_WAIT_FOR_WRITABLE, trace.waitCookie);
  trace.waitCookie = null;
}

/** Begins at the exact call into the native Herdr resize enqueue path. */
export function terminalResizeNativeDispatchStarted(trace: TerminalResizeTrace | null): void {
  if (!trace || trace.ended || trace.nativeCookie !== null) return;
  endTerminalResizeWait(trace);
  trace.nativeCookie = beginAsyncEvent(RESIZE_NATIVE_DISPATCH);
  trace.firstFrameCookie = beginAsyncEvent(RESIZE_TO_FIRST_FRAME);
  trace.visibleCookie = beginAsyncEvent(RESIZE_TO_VISIBLE);
  const queue = pendingResizeByTarget.get(trace.targetKey) || [];
  queue.push(trace);
  pendingResizeByTarget.set(trace.targetKey, queue);
  trace.queuedForFrame = true;
  trace.timeout = setTimeout(() => finishTerminalResizeTrace(trace), TRACE_TIMEOUT_MS);
}

export function terminalResizeNativeDispatchEnded(
  trace: TerminalResizeTrace | null,
  success: boolean,
): void {
  if (!trace || trace.ended) return;
  if (trace.nativeCookie !== null) {
    endAsyncEvent(RESIZE_NATIVE_DISPATCH, trace.nativeCookie);
    trace.nativeCookie = null;
  }
  if (!success) finishTerminalResizeTrace(trace);
}

function removePendingResize(trace: TerminalResizeTrace): void {
  if (trace.queuedForFrame) {
    const queue = pendingResizeByTarget.get(trace.targetKey);
    const next = queue?.filter(item => item !== trace) || [];
    if (next.length) pendingResizeByTarget.set(trace.targetKey, next);
    else pendingResizeByTarget.delete(trace.targetKey);
  }
  if (trace.visibleCookie !== null) pendingResizeByVisibleCookie.delete(trace.visibleCookie);
}

function finishTerminalResizeTrace(trace: TerminalResizeTrace): void {
  if (trace.ended) return;
  trace.ended = true;
  endAppPerformanceTrace(trace.request);
  endTerminalResizeWait(trace);
  if (trace.nativeCookie !== null) endAsyncEvent(RESIZE_NATIVE_DISPATCH, trace.nativeCookie);
  if (trace.firstFrameCookie !== null) endAsyncEvent(RESIZE_TO_FIRST_FRAME, trace.firstFrameCookie);
  if (trace.frameToVisibleCookie !== null) {
    endAsyncEvent(RESIZE_FRAME_TO_VISIBLE, trace.frameToVisibleCookie);
  }
  if (trace.visibleCookie !== null) endAsyncEvent(RESIZE_TO_VISIBLE, trace.visibleCookie);
  removePendingResize(trace);
  if (trace.timeout) clearTimeout(trace.timeout);
  trace.timeout = null;
}

/** Marks a cold request replaced before any native resize was dispatched. */
export function terminalResizeSuperseded(trace: TerminalResizeTrace | null): void {
  if (!trace || trace.ended) return;
  const cookie = beginAsyncEvent(RESIZE_SUPERSEDED);
  endAsyncEvent(RESIZE_SUPERSEDED, cookie);
  finishTerminalResizeTrace(trace);
}

/** Marks an exact-size request skipped because the same tuple was already dispatched. */
export function terminalResizeDeduplicated(trace: TerminalResizeTrace | null): void {
  if (!trace || trace.ended) return;
  const cookie = beginAsyncEvent(RESIZE_DEDUPLICATED);
  endAsyncEvent(RESIZE_DEDUPLICATED, cookie);
  finishTerminalResizeTrace(trace);
}

export function abandonTerminalResizeTrace(trace: TerminalResizeTrace | null): void {
  if (trace) finishTerminalResizeTrace(trace);
}

/** Claims the first renderer-bound terminal frame after a native resize dispatch. */
export function terminalResizeFrameReceived(targetKey: string): number | null {
  const queue = pendingResizeByTarget.get(targetKey);
  let trace = queue?.shift();
  while (trace?.ended) {
    trace = queue?.shift();
  }
  if (!queue?.length) pendingResizeByTarget.delete(targetKey);
  if (trace?.visibleCookie === null || trace?.visibleCookie === undefined) return null;
  trace.queuedForFrame = false;
  if (trace.firstFrameCookie !== null) {
    endAsyncEvent(RESIZE_TO_FIRST_FRAME, trace.firstFrameCookie);
    trace.firstFrameCookie = null;
  }
  trace.frameToVisibleCookie = beginAsyncEvent(RESIZE_FRAME_TO_VISIBLE);
  pendingResizeByVisibleCookie.set(trace.visibleCookie, trace);
  return trace.visibleCookie;
}

export function terminalResizeFrameRendered(visibleCookie: number): void {
  const trace = pendingResizeByVisibleCookie.get(visibleCookie);
  if (trace) finishTerminalResizeTrace(trace);
}

function endWrite(trace: TerminalInputTrace, _result: 'ok' | 'error' | 'timeout'): void {
  if (trace.writeEnded) return;
  trace.writeEnded = true;
  endAsyncEvent(INPUT_TO_WRITE, trace.writeCookie);
}

function endNativePhases(trace: TerminalInputTrace): void {
  if (trace.preNativeWaitCookie !== null) {
    endAsyncEvent(PRE_NATIVE_WAIT, trace.preNativeWaitCookie);
    trace.preNativeWaitCookie = null;
  }
  if (trace.nativeEnqueueCookie !== null) {
    endAsyncEvent(NATIVE_ENQUEUE, trace.nativeEnqueueCookie);
    trace.nativeEnqueueCookie = null;
  }
  if (trace.nativeQueueToResponseCookie !== null) {
    endAsyncEvent(NATIVE_QUEUE_TO_RESPONSE, trace.nativeQueueToResponseCookie);
    trace.nativeQueueToResponseCookie = null;
  }
  if (trace.nativeResponseToRendererCookie !== null) {
    endAsyncEvent(NATIVE_RESPONSE_TO_RENDERER, trace.nativeResponseToRendererCookie);
    trace.nativeResponseToRendererCookie = null;
  }
}

function removeFromTargetQueue(trace: TerminalInputTrace): void {
  const queue = pendingByTarget.get(trace.targetKey);
  if (!queue) return;
  const next = queue.filter(item => item !== trace);
  if (next.length) pendingByTarget.set(trace.targetKey, next);
  else pendingByTarget.delete(trace.targetKey);
}

function endVisible(trace: TerminalInputTrace, _result: 'visible' | 'error' | 'timeout'): void {
  if (trace.visibleEnded) return;
  trace.visibleEnded = true;
  endAsyncEvent(INPUT_TO_VISIBLE, trace.visibleCookie);
  if (trace.frameToVisibleCookie !== null) {
    endAsyncEvent(FRAME_TO_VISIBLE, trace.frameToVisibleCookie);
  }
  pendingByVisibleCookie.delete(trace.visibleCookie);
  clearTimeout(trace.timeout);
}

function abandonTrace(trace: TerminalInputTrace, result: 'error' | 'timeout'): void {
  endWrite(trace, result);
  endNativePhases(trace);
  if (!trace.frameReceived) {
    trace.frameReceived = true;
    endAsyncEvent(INPUT_TO_FRAME, trace.frameCookie);
  }
  removeFromTargetQueue(trace);
  endVisible(trace, result);
}

/** Starts a trace only while Perfetto has React Native tracing enabled. */
export function beginTerminalInputTrace(
  targetKey: string,
  _kind: 'input' | 'submit',
): TerminalInputTrace | null {
  if (Platform.OS !== 'android' || !performanceTrace) return null;

  const writeCookie = nextTraceCookie();
  if (!performanceTrace.beginAsyncSection(INPUT_TO_WRITE, writeCookie)) return null;
  const trace = {
    targetKey,
    writeCookie,
    frameCookie: beginAsyncEvent(INPUT_TO_FRAME),
    visibleCookie: beginAsyncEvent(INPUT_TO_VISIBLE),
    frameToVisibleCookie: null,
    preNativeWaitCookie: null,
    nativeEnqueueCookie: null,
    nativeQueueToResponseCookie: null,
    nativeResponseToRendererCookie: null,
    writeEnded: false,
    frameReceived: false,
    nativeResponseReceived: false,
    visibleEnded: false,
    timeout: undefined as unknown as ReturnType<typeof setTimeout>,
  } satisfies TerminalInputTrace;
  trace.timeout = setTimeout(() => abandonTrace(trace, 'timeout'), TRACE_TIMEOUT_MS);
  const queue = pendingByTarget.get(targetKey) || [];
  queue.push(trace);
  pendingByTarget.set(targetKey, queue);
  return trace;
}

export function endTerminalWriteTrace(trace: TerminalInputTrace | null, success: boolean): void {
  if (!trace) return;
  if (success) endWrite(trace, 'ok');
  else abandonTrace(trace, 'error');
}

/** Keeps the write slice open until the operation has actually settled. */
export async function withTerminalWriteTrace<Result>(
  trace: TerminalInputTrace | null,
  operation: () => Result | Promise<Result>,
): Promise<Result> {
  try {
    const result = await operation();
    endTerminalWriteTrace(trace, true);
    return result;
  } catch (error) {
    endTerminalWriteTrace(trace, false);
    throw error;
  }
}

/** Covers app-owned bridge readiness and scheduling before entering native code. */
export function terminalNativePreflightStarted(trace: TerminalInputTrace | null): void {
  if (!trace || trace.visibleEnded || trace.preNativeWaitCookie !== null) return;
  trace.preNativeWaitCookie = beginAsyncEvent(PRE_NATIVE_WAIT);
}

/** Starts immediately before Whip calls the merged Rust core's UniFFI fast path. */
export function terminalNativeWriteStarted(trace: TerminalInputTrace | null): void {
  if (!trace || trace.visibleEnded || trace.nativeEnqueueCookie !== null) return;
  if (trace.preNativeWaitCookie !== null) {
    endAsyncEvent(PRE_NATIVE_WAIT, trace.preNativeWaitCookie);
    trace.preNativeWaitCookie = null;
  }
  trace.nativeEnqueueCookie = beginAsyncEvent(NATIVE_ENQUEUE);
}

/** Ends after Rust validates, frames, and queues the write for russh. */
export function terminalNativeWriteQueued(
  trace: TerminalInputTrace | null,
  success: boolean,
): void {
  if (!trace) return;
  if (trace.nativeEnqueueCookie !== null) {
    endAsyncEvent(NATIVE_ENQUEUE, trace.nativeEnqueueCookie);
    trace.nativeEnqueueCookie = null;
  }
  if (
    success
    && !trace.visibleEnded
    && !trace.nativeResponseReceived
    && trace.nativeQueueToResponseCookie === null
  ) {
    trace.nativeQueueToResponseCookie = beginAsyncEvent(NATIVE_QUEUE_TO_RESPONSE);
  }
}

/** Claims the first returned terminal frame for this input. */
export function terminalNativeResponseReceived(trace: TerminalInputTrace): boolean {
  if (trace.visibleEnded || trace.nativeResponseReceived) return false;
  trace.nativeResponseReceived = true;
  if (trace.nativeEnqueueCookie !== null) {
    endAsyncEvent(NATIVE_ENQUEUE, trace.nativeEnqueueCookie);
    trace.nativeEnqueueCookie = null;
  }
  if (trace.nativeQueueToResponseCookie !== null) {
    endAsyncEvent(NATIVE_QUEUE_TO_RESPONSE, trace.nativeQueueToResponseCookie);
    trace.nativeQueueToResponseCookie = null;
  }
  trace.nativeResponseToRendererCookie = beginAsyncEvent(NATIVE_RESPONSE_TO_RENDERER);
  return true;
}

/** Ends after HerdrClient synchronously hands the frame to the WebView renderer. */
export function terminalNativeResponseDelivered(trace: TerminalInputTrace | null): void {
  if (
    trace?.nativeResponseToRendererCookie === null
    || trace?.nativeResponseToRendererCookie === undefined
  ) return;
  endAsyncEvent(NATIVE_RESPONSE_TO_RENDERER, trace.nativeResponseToRendererCookie);
  trace.nativeResponseToRendererCookie = null;
}

/** Returns the cookie that the WebView must acknowledge after xterm paints. */
export function terminalFrameReceived(targetKey: string): number | null {
  const queue = pendingByTarget.get(targetKey);
  const trace = queue?.shift();
  if (!trace) return null;
  if (!queue?.length) pendingByTarget.delete(targetKey);
  trace.frameReceived = true;
  endAsyncEvent(INPUT_TO_FRAME, trace.frameCookie);
  trace.frameToVisibleCookie = beginAsyncEvent(FRAME_TO_VISIBLE);
  pendingByVisibleCookie.set(trace.visibleCookie, trace);
  return trace.visibleCookie;
}

export function terminalFrameRendered(visibleCookie: number): void {
  const trace = pendingByVisibleCookie.get(visibleCookie);
  if (trace) endVisible(trace, 'visible');
}
