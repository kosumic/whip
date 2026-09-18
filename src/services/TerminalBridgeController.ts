import {
  type HerdrBridgeEvent,
  type HostRuntimeConnection,
  type RuntimeTerminalGeometry,
  type RuntimeTerminalResizeOutcome,
} from 'react-native-whip-ssh';

import { type TerminalControlEvent, type TerminalFrame } from '../lib/terminalBridge';
import { isSshShellTerminalId } from '../terminalSessions';
import {
  abandonTerminalResizeTrace,
  beginAppPerformanceTrace,
  endAppPerformanceTrace,
  terminalNativePreflightStarted,
  terminalNativeResponseDelivered,
  terminalNativeResponseReceived,
  terminalNativeWriteQueued,
  terminalNativeWriteStarted,
  terminalResizeDeduplicated,
  terminalResizeNativeDispatchEnded,
  terminalResizeNativeDispatchStarted,
  terminalResizeSuperseded,
  terminalResizeWaitStarted,
  type TerminalInputTrace,
  type TerminalResizeTrace,
} from './performanceTrace';
import {
  networkErrorKind,
  networkErrorMessage,
  recordNetworkDiagnostic,
} from './networkDiagnostics';

type TerminalFrameHandler = (frame: TerminalFrame) => void;
type TerminalClosedHandler = (reason?: string) => void;
type TerminalControlHandler = (event: TerminalControlEvent) => void;

declare const terminalAttachmentIdBrand: unique symbol;

/** Opaque ownership token for one installed terminal controller. */
export type TerminalAttachmentId = {
  readonly [terminalAttachmentIdBrand]: true;
};

interface TerminalAttachment {
  attachmentId: TerminalAttachmentId;
  onFrame: TerminalFrameHandler;
  onClosed?: TerminalClosedHandler;
  onControl?: TerminalControlHandler;
  sequence: number;
}

const DEFAULT_TERMINAL_SIZE: RuntimeTerminalGeometry = {
  columns: 80,
  rows: 24,
  cellWidthPx: 0,
  cellHeightPx: 0,
};

const TERMINAL_STATE_REFRESH_DEBOUNCE_MS = 120;

/** Owns the JavaScript attachment, tracing, and lifecycle state around native terminals. */
export class TerminalBridgeController {
  private readonly attachments = new Map<string, TerminalAttachment>();
  private readonly inputTraces = new Map<string, TerminalInputTrace[]>();
  private readonly pendingResizeTraces = new Map<string, TerminalResizeTrace>();
  private stateRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly currentRuntime: () => HostRuntimeConnection | null) {}

  async openTerminal(
    terminalId: string,
    onFrame: TerminalFrameHandler,
    onClosed?: TerminalClosedHandler,
    onControl?: TerminalControlHandler,
  ): Promise<TerminalAttachmentId> {
    const attachmentId = Object.freeze({}) as TerminalAttachmentId;
    const previousAttachment = this.attachments.get(terminalId);
    this.attachments.set(terminalId, {
      attachmentId,
      onFrame,
      onClosed,
      onControl,
      sequence: previousAttachment?.sequence ?? 0,
    });
    if (isSshShellTerminalId(terminalId)) {
      try {
        await this.attachSshShell(terminalId);
      } catch (error) {
        if (this.attachments.get(terminalId)?.attachmentId === attachmentId) {
          this.attachments.delete(terminalId);
        }
        throw error;
      }
      return attachmentId;
    }

    const coldAttach = !this.requireRuntime().hasHerdrBridge(terminalId);
    const bridgeAttachTrace = coldAttach
      ? beginAppPerformanceTrace('Whip terminal bridge attach')
      : null;
    try {
      await this.attachTerminal(terminalId, coldAttach);
      this.attachments.get(terminalId)?.onControl?.({
        type: 'protocol-state',
        state: this.requireRuntime().herdrBridgeProtocolState(terminalId),
      });
    } catch (error) {
      if (this.attachments.get(terminalId)?.attachmentId === attachmentId) {
        this.attachments.delete(terminalId);
      }
      throw error;
    } finally {
      endAppPerformanceTrace(bridgeAttachTrace);
    }
    return attachmentId;
  }

  async writeToTerminal(
    terminalId: string,
    data: string,
    inputTrace: TerminalInputTrace | null = null,
  ): Promise<string> {
    terminalNativePreflightStarted(inputTrace);
    if (isSshShellTerminalId(terminalId)) {
      this.queueInputTrace(terminalId, inputTrace);
      terminalNativeWriteStarted(inputTrace);
      try {
        const runtime = this.requireRuntime();
        if (!runtime.hasSshShell(terminalId)) {
          throw new Error(`SSH shell ${terminalId} is not connected`);
        }
        const bytes = new TextEncoder().encode(data);
        const buffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        );
        runtime.sshShellInput(terminalId, buffer);
        terminalNativeWriteQueued(inputTrace, true);
        return '';
      } catch (error) {
        terminalNativeWriteQueued(inputTrace, false);
        this.removeInputTrace(terminalId, inputTrace);
        throw error;
      }
    }
    const runtime = this.requireRuntime();
    if (!runtime.hasHerdrBridge(terminalId)) {
      await this.ensureTerminalBridge(terminalId);
    }
    this.queueInputTrace(terminalId, inputTrace);
    terminalNativeWriteStarted(inputTrace);
    try {
      await runtime.herdrBridgeInput(terminalId, data);
      terminalNativeWriteQueued(inputTrace, true);
    } catch (error) {
      terminalNativeWriteQueued(inputTrace, false);
      this.removeInputTrace(terminalId, inputTrace);
      throw error;
    }
    return '';
  }

  async resizeTerminal(
    terminalId: string,
    columns: number,
    rows: number,
    cellWidthPx = 0,
    cellHeightPx = 0,
    performanceTrace: TerminalResizeTrace | null = null,
    forceDispatch = false,
  ): Promise<void> {
    const size = {
      columns,
      rows,
      cellWidthPx: Math.max(0, Math.round(cellWidthPx)),
      cellHeightPx: Math.max(0, Math.round(cellHeightPx)),
    };
    terminalResizeWaitStarted(performanceTrace);
    const runtime = this.requireRuntime();
    const sshShell = isSshShellTerminalId(terminalId);
    const expectedDispatch = sshShell
      ? runtime.hasSshShell(terminalId)
      : runtime.hasHerdrBridge(terminalId);
    if (expectedDispatch) terminalResizeNativeDispatchStarted(performanceTrace);

    let outcome: RuntimeTerminalResizeOutcome;
    try {
      outcome = sshShell
        ? runtime.resizeSshShell(
          terminalId,
          size.columns,
          size.rows,
          size.cellWidthPx,
          size.cellHeightPx,
          forceDispatch,
        )
        : await runtime.herdrBridgeResize(
          terminalId,
          size.columns,
          size.rows,
          size.cellWidthPx,
          size.cellHeightPx,
          forceDispatch,
        );
    } catch (error) {
      terminalResizeNativeDispatchEnded(performanceTrace, false);
      throw error;
    }
    if (outcome === 'dispatched') {
      if (!expectedDispatch) terminalResizeNativeDispatchStarted(performanceTrace);
      terminalResizeNativeDispatchEnded(performanceTrace, true);
      return;
    }
    if (outcome === 'deduplicated') {
      terminalResizeDeduplicated(performanceTrace);
      return;
    }
    if (performanceTrace) {
      if (!sshShell && runtime.isHerdrBridgeOpening(terminalId)) {
        terminalResizeSuperseded(performanceTrace);
        return;
      }
      terminalResizeSuperseded(this.pendingResizeTraces.get(terminalId) || null);
      this.pendingResizeTraces.set(terminalId, performanceTrace);
    }
  }

  async scrollTerminal(
    terminalId: string,
    direction: 'up' | 'down',
    lines: number,
    column?: number,
    row?: number,
  ): Promise<string> {
    if (isSshShellTerminalId(terminalId)) return '';
    await this.ensureTerminalBridge(terminalId);
    await this.requireRuntime().herdrBridgeScroll(
      terminalId,
      direction === 'up',
      Math.max(1, Math.round(lines)),
      column,
      row,
    );
    this.scheduleStateRefresh();
    return '';
  }

  closeTerminal(terminalId: string): void {
    this.attachments.delete(terminalId);
    this.clearBridgeState(terminalId);
    if (isSshShellTerminalId(terminalId)) {
      this.currentRuntime()?.closeSshShell(terminalId);
      return;
    }
    this.currentRuntime()?.closeHerdrBridge(terminalId);
  }

  isTerminalBridgeRetained(terminalId: string): boolean {
    return isSshShellTerminalId(terminalId)
      ? Boolean(this.currentRuntime()?.hasSshShell(terminalId))
      : Boolean(this.currentRuntime()?.hasHerdrBridge(terminalId));
  }

  releaseTerminal(
    terminalId: string,
    attachmentId: TerminalAttachmentId,
  ): void {
    const attachment = this.attachments.get(terminalId);
    if (attachment?.attachmentId !== attachmentId) return;

    this.attachments.delete(terminalId);
    this.clearBridgeState(terminalId);
    if (isSshShellTerminalId(terminalId)) {
      this.currentRuntime()?.closeSshShell(terminalId);
    } else {
      this.currentRuntime()?.closeHerdrBridge(terminalId);
    }
  }

  detachTerminal(
    terminalId: string,
    attachmentId: TerminalAttachmentId,
  ): void {
    const attachment = this.attachments.get(terminalId);
    if (attachment?.attachmentId !== attachmentId) return;
    this.attachments.delete(terminalId);
    if (isSshShellTerminalId(terminalId)) {
      this.currentRuntime()?.closeSshShell(terminalId);
    } else {
      this.currentRuntime()?.detachHerdrBridge(terminalId);
    }
  }

  closeTerminalBridge(terminalId: string): void {
    this.closeTerminal(terminalId);
  }

  releaseAllTerminals(): void {
    const runtime = this.currentRuntime();
    if (runtime) {
      for (const terminalId of this.attachments.keys()) {
        if (isSshShellTerminalId(terminalId)) runtime.closeSshShell(terminalId);
      }
      runtime.closeAllHerdrBridges();
    }
    this.cancelStateRefresh();
    this.clearAllState();
  }

  /** Clears JS-owned state before its native runtime is disconnected. */
  reset(runtime: HostRuntimeConnection): void {
    this.cancelStateRefresh();
    for (const terminalId of this.attachments.keys()) {
      if (isSshShellTerminalId(terminalId)) runtime.closeSshShell(terminalId);
    }
    this.clearAllState();
  }

  /** A disappearing UI releases callbacks and timers, not native terminals. */
  detach(): void {
    this.cancelStateRefresh();
    this.clearAllState();
  }

  private requireRuntime(): HostRuntimeConnection {
    const runtime = this.currentRuntime();
    if (!runtime) throw new Error('Host runtime is not active');
    return runtime;
  }

  private async attachSshShell(terminalId: string): Promise<void> {
    const runtime = this.requireRuntime();
    const size = runtime.sshShellGeometry(terminalId) || DEFAULT_TERMINAL_SIZE;
    const resizeTrace = this.pendingResizeTraces.get(terminalId) || null;
    const onData = (data: ArrayBuffer) => {
      const active = this.attachments.get(terminalId);
      if (!active) return;
      const activeSize = this.currentRuntime()?.sshShellGeometry(terminalId) || size;
      this.deliverTracedFrame(terminalId, () => {
        active.onFrame({
          type: 'terminal.frame',
          seq: ++active.sequence,
          encoding: 'utf8',
          width: activeSize.columns,
          height: activeSize.rows,
          full: false,
          bytes: data,
        });
      });
    };
    terminalResizeNativeDispatchStarted(resizeTrace);
    try {
      await runtime.openSshShell(
        terminalId,
        size.columns,
        size.rows,
        size.cellWidthPx,
        size.cellHeightPx,
        {
          data: onData,
          closed: reason => {
            this.attachments.get(terminalId)?.onClosed?.(reason);
          },
        },
      );
      this.pendingResizeTraces.delete(terminalId);
      terminalResizeNativeDispatchEnded(resizeTrace, true);
    } catch (error) {
      this.pendingResizeTraces.delete(terminalId);
      terminalResizeNativeDispatchEnded(resizeTrace, false);
      throw error;
    }
  }

  private async attachTerminal(terminalId: string, coldAttach: boolean): Promise<void> {
    const resizeTrace = this.pendingResizeTraces.get(terminalId) || null;
    const initialResizeTrace = coldAttach
      ? beginAppPerformanceTrace('Whip Herdr terminal initial resize')
      : null;
    const uncorrelatedNativeDispatchTrace = resizeTrace
      ? null
      : beginAppPerformanceTrace('Whip terminal resize native dispatch');
    terminalResizeNativeDispatchStarted(resizeTrace);
    try {
      await this.ensureTerminalBridge(terminalId);
      this.pendingResizeTraces.delete(terminalId);
      this.scheduleStateRefresh();
      terminalResizeNativeDispatchEnded(resizeTrace, true);
    } catch (error) {
      this.pendingResizeTraces.delete(terminalId);
      terminalResizeNativeDispatchEnded(resizeTrace, false);
      throw error;
    } finally {
      endAppPerformanceTrace(uncorrelatedNativeDispatchTrace);
      endAppPerformanceTrace(initialResizeTrace);
    }
  }

  private async ensureTerminalBridge(terminalId: string): Promise<void> {
    const runtime = this.requireRuntime();
    const size = runtime.herdrBridgeGeometry(terminalId) || DEFAULT_TERMINAL_SIZE;
    await runtime.startHerdrBridge(
      terminalId,
      true,
      size.columns,
      size.rows,
      size.cellWidthPx,
      size.cellHeightPx,
      event => this.handleHerdrBridgeEvent(terminalId, event),
    );
  }

  private scheduleStateRefresh(): void {
    if (this.stateRefreshTimer !== null) clearTimeout(this.stateRefreshTimer);
    this.stateRefreshTimer = setTimeout(() => {
      this.stateRefreshTimer = null;
      this.currentRuntime()?.refreshState().catch(error => {
        recordRuntimeCleanupFailure('terminal-state-refresh-failed', error);
      });
    }, TERMINAL_STATE_REFRESH_DEBOUNCE_MS);
  }

  private cancelStateRefresh(): void {
    if (this.stateRefreshTimer === null) return;
    clearTimeout(this.stateRefreshTimer);
    this.stateRefreshTimer = null;
  }

  private handleHerdrBridgeEvent(terminalId: string, event: HerdrBridgeEvent): void {
    if (event.type === 'terminal') {
      if (
        typeof event.seq === 'number'
        && typeof event.width === 'number'
        && typeof event.height === 'number'
        && (
          typeof event.bytes === 'string'
          || event.bytes instanceof ArrayBuffer
          || ArrayBuffer.isView(event.bytes)
        )
      ) {
        this.deliverTracedFrame(terminalId, () => {
          this.attachments.get(terminalId)?.onFrame({
            type: 'terminal.frame',
            seq: event.seq as number,
            encoding: 'ansi',
            width: event.width as number,
            height: event.height as number,
            full: Boolean(event.full),
            bytes: event.bytes as string | ArrayBufferView,
            final: event.final !== false,
            inboundTraceCookie: event.inboundTraceCookie ?? null,
          });
        });
      }
      return;
    }
    if (event.type === 'terminal_bell') {
      const count = Math.max(0, Math.min(0xffff, Math.trunc(event.count || 0)));
      if (count > 0) {
        this.attachments.get(terminalId)?.onFrame({
          type: 'terminal.frame',
          seq: 0,
          encoding: 'utf8',
          width: 0,
          height: 0,
          full: false,
          bytes: '\u0007'.repeat(count),
        });
      }
      return;
    }
    if (event.type === 'mouse_capture') {
      // Direct attachments do not render the Herdr TUI, whose mouse setting
      // must not control Whip's terminal surface.
      return;
    }
    if (event.type === 'kitty_keyboard_report_all') {
      this.attachments.get(terminalId)?.onControl?.({
        type: 'protocol-state',
        state: { kittyKeyboardReportAll: event.flag === true },
      });
      return;
    }
    if (event.type === 'clipboard') {
      this.attachments.get(terminalId)?.onControl?.({
        type: 'clipboard-write',
        text: event.text || '',
      });
      return;
    }
    if (event.type === 'title') {
      this.attachments.get(terminalId)?.onControl?.({
        type: 'title',
        title: event.text || '',
      });
      return;
    }
    if (event.type === 'closed') {
      this.clearBridgeState(terminalId);
      this.attachments.get(terminalId)?.onClosed?.(
        event.text || 'Herdr remote-client-bridge closed',
      );
    }
  }

  private clearBridgeState(terminalId: string): void {
    abandonTerminalResizeTrace(this.pendingResizeTraces.get(terminalId) || null);
    this.pendingResizeTraces.delete(terminalId);
    this.inputTraces.delete(terminalId);
  }

  private clearAllState(): void {
    for (const trace of this.pendingResizeTraces.values()) {
      abandonTerminalResizeTrace(trace);
    }
    this.pendingResizeTraces.clear();
    this.inputTraces.clear();
    this.attachments.clear();
  }

  private queueInputTrace(terminalId: string, trace: TerminalInputTrace | null): void {
    if (!trace) return;
    const queue = this.inputTraces.get(terminalId) || [];
    queue.push(trace);
    this.inputTraces.set(terminalId, queue);
  }

  private removeInputTrace(terminalId: string, trace: TerminalInputTrace | null): void {
    if (!trace) return;
    const queue = this.inputTraces.get(terminalId);
    if (!queue) return;
    const next = queue.filter(item => item !== trace);
    if (next.length) this.inputTraces.set(terminalId, next);
    else this.inputTraces.delete(terminalId);
  }

  private takeInputTrace(terminalId: string): TerminalInputTrace | null {
    const queue = this.inputTraces.get(terminalId);
    if (!queue) return null;
    while (queue.length > 0) {
      const trace = queue.shift();
      if (trace && terminalNativeResponseReceived(trace)) {
        if (queue.length === 0) this.inputTraces.delete(terminalId);
        return trace;
      }
    }
    this.inputTraces.delete(terminalId);
    return null;
  }

  private deliverTracedFrame(terminalId: string, deliver: () => void): void {
    const trace = this.takeInputTrace(terminalId);
    try {
      deliver();
    } finally {
      terminalNativeResponseDelivered(trace);
    }
  }
}

function recordRuntimeCleanupFailure(event: string, error: unknown): void {
  recordNetworkDiagnostic('warn', event, {
    error: networkErrorMessage(error),
    errorKind: networkErrorKind(error),
  });
}
