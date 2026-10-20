import type { TerminalFrame } from './terminalBridge';

export interface TerminalFrameSequenceResult {
  render: boolean;
  reset: boolean;
  requestFull: boolean;
}

/**
 * Validates Herdr terminal-ANSI frame ordering without inspecting frame bytes.
 * `seq` advances once per complete encoded frame; chunks share a sequence until
 * `final`. `full` is a complete visible repaint, not historical scrollback.
 */
export class TerminalFrameSequence {
  // Shared immutable results avoid one metadata allocation per ordinary frame.
  private static readonly KEEP = Object.freeze({ render: true, reset: false, requestFull: false });
  private static readonly DROP = Object.freeze({ render: false, reset: false, requestFull: false });
  private lastComplete: number | null = null;
  private pending: number | null = null;
  private awaitingFull = false;

  reset(): void {
    this.lastComplete = null;
    this.pending = null;
    this.awaitingFull = false;
  }

  observe(frame: Pick<TerminalFrame, 'seq' | 'full' | 'final'>): TerminalFrameSequenceResult {
    const final = frame.final !== false;
    const validSequence = Number.isSafeInteger(frame.seq) && frame.seq > 0;
    const beginsFrame = this.pending === null || this.pending !== frame.seq;

    if (!validSequence) return this.requireFull(!this.awaitingFull);

    if (this.awaitingFull) {
      if (!frame.full || !beginsFrame) return TerminalFrameSequence.DROP;
      return this.accept(frame.seq, final, true);
    }

    if (this.pending !== null && this.pending !== frame.seq) {
      return frame.full
        ? this.accept(frame.seq, final, true)
        : this.requireFull(true);
    }

    if (beginsFrame) {
      const expected = this.lastComplete === null ? null : this.lastComplete + 1;
      if (expected === null && !frame.full) return this.requireFull(true);
      if (expected !== null && frame.seq !== expected) {
        return frame.full
          ? this.accept(frame.seq, final, true)
          : this.requireFull(true);
      }
      this.pending = frame.seq;
    }

    if (final) {
      this.lastComplete = frame.seq;
      this.pending = null;
    }
    return TerminalFrameSequence.KEEP;
  }

  private accept(seq: number, final: boolean, reset: boolean): TerminalFrameSequenceResult {
    this.awaitingFull = false;
    this.pending = final ? null : seq;
    if (final) this.lastComplete = seq;
    return { render: true, reset, requestFull: false };
  }

  private requireFull(requestFull: boolean): TerminalFrameSequenceResult {
    this.awaitingFull = true;
    this.pending = null;
    return { render: false, reset: false, requestFull };
  }
}
