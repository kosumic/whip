import {
  ComposerDictation,
  DictationPhase,
} from './generated-entry';

export { appendComposerDictation, composerDictationContext } from './generated-entry';

const PHASES = {
  [DictationPhase.Idle]: 'idle',
  [DictationPhase.Preparing]: 'preparing',
  [DictationPhase.Listening]: 'listening',
  [DictationPhase.Finishing]: 'finishing',
} as const;

export type ComposerDictationPhase = typeof PHASES[keyof typeof PHASES];

/** Rust owns the session state and partial/final recognition semantics. */
export class NativeComposerDictation {
  private readonly core = new ComposerDictation();

  view(): { phase: ComposerDictationPhase; interimText: string } {
    const view = this.core.view();
    return { phase: PHASES[view.phase], interimText: view.interimText };
  }

  begin(): void { this.core.begin(); }
  listening(): void { this.core.listening(); }
  finish(): void { this.core.finish(); }
  result(text: string, isFinal: boolean): string | undefined { return this.core.result(text, isFinal); }
  end(): string | undefined { return this.core.end(); }
  dispose(): void { this.core.uniffiDestroy(); }
}
