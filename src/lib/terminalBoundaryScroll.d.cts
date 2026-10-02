export type TerminalBoundary = 'top' | 'bottom' | null;

export interface TerminalBoundaryScrollState {
  offsetFromBottom: number;
  maxOffsetFromBottom: number;
  boundary: TerminalBoundary;
  boundaryRevealPx: number;
  boundaryAllowancePx: number;
  rowRemainderPx: number;
}

export interface TerminalBoundaryAllowances {
  topAllowancePx: number;
  bottomAllowancePx: number;
  alternateScreen?: boolean;
}

export interface TerminalBoundaryScrollResult
  extends TerminalBoundaryScrollState {
  rowScrollDelta: number;
  unconsumedGesturePx: number;
  visualOffset: number;
}

export function terminalBoundaryVisualOffset(input: {
  alternateScreen?: boolean;
  boundary?: TerminalBoundary;
  boundaryRevealPx?: number;
}): number;

export function terminalAtVisualBottom(input: {
  state?: Partial<TerminalBoundaryScrollState>;
  bottomAllowancePx: number;
  alternateScreen?: boolean;
}): boolean;

export function terminalBoundaryScrollToVisualBottom(input: {
  state?: Partial<TerminalBoundaryScrollState>;
  bottomAllowancePx: number;
  alternateScreen?: boolean;
}): TerminalBoundaryScrollState;

export function reconcileTerminalBoundaryScroll(input: {
  state?: Partial<TerminalBoundaryScrollState>;
  offsetFromBottom: number;
  maxOffsetFromBottom: number;
} & TerminalBoundaryAllowances): TerminalBoundaryScrollState;

export function terminalBoundaryScroll(input: {
  state: TerminalBoundaryScrollState;
  gestureDeltaPx: number;
  cellHeightPx: number;
} & TerminalBoundaryAllowances): TerminalBoundaryScrollResult;

export function terminalUnconsumedScrollRows(input: {
  unconsumedGesturePx: number;
  remainderPx?: number;
  cellHeightPx: number;
}): { rows: number; remainderPx: number };
