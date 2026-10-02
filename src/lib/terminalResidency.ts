import type { TerminalRenderTarget } from './terminalRenderer';

export enum TerminalResidencyEndReason {
  Evicted = 'evicted',
  Closed = 'closed',
}

/** Emitted by the terminal LRU when attached resources must be released. */
export type TerminalResidencyEnd = (
  target: TerminalRenderTarget,
  reason: TerminalResidencyEndReason,
) => void;
