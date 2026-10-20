/** Compatibility callback shape; native renderer output normally uses Rust batches. */
export interface TerminalFrame {
  type: 'terminal.frame';
  /** Per terminal-ANSI client frame number; chunks of one frame share a seq. */
  seq: number;
  /** ANSI strings are already base64 encoded in Rust; binary views remain raw bytes. */
  encoding: 'ansi' | 'utf8';
  width: number;
  height: number;
  /**
   * True when Herdr painted every visible cell (initial baseline, resize, or
   * requested repaint). This is not pane scrollback and repaint frames may omit
   * a clear, so only use it as a visible baseline after resetting locally.
   */
  full: boolean;
  bytes: string | ArrayBuffer | ArrayBufferView;
  /** Present when a large base64 frame is already split into bridge-safe chunks. */
  final?: boolean;
  /** Perfetto-only correlation cookie; absent when Android tracing is disabled. */
  inboundTraceCookie?: number | null;
}

export interface TerminalClosed {
  type: 'terminal.closed';
  reason?: string;
}

/** Kitty graphics output is ordered with text, but has no text-frame sequence. */
export interface TerminalGraphics {
  type: 'terminal.graphics';
  /** Strings contain base64; binary views contain the original protocol bytes. */
  bytes: TerminalFrame['bytes'];
}

export type TerminalOutput = TerminalFrame | TerminalGraphics;

export interface TerminalProtocolState {
  kittyKeyboardReportAll: boolean;
}

export type TerminalControlEvent =
  | { type: 'protocol-state'; state: TerminalProtocolState }
  | { type: 'mouse-capture'; enabled: boolean }
  | { type: 'clipboard-write'; text: string }
  | { type: 'title'; title: string };

export type TerminalBridgeEvent = TerminalOutput | TerminalClosed;
