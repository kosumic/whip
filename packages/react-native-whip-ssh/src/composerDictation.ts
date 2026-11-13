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

export interface DictationConfig {
  owner: string;
  draft: string;
  android: boolean;
  api: number;
  provider: 'default' | 'local' | 'openai';
  localOnly: boolean;
  managedCall: boolean;
  duringPlayback: boolean;
  nativeIngress: boolean;
}
export interface DictationScope { id: string; generation: string; epoch: string }
export type DictationOutcome =
  | { kind: 'loaded'; available: boolean; localSupported: boolean; ingressSupported: boolean }
  | { kind: 'context'; recent: string[] }
  | { kind: 'permission' | 'cloudStarted'; granted: boolean }
  | { kind: 'done' | 'captureFailed' }
  | { kind: 'transcript'; text: string }
  | { kind: 'idle'; inactive: boolean }
  | { kind: 'failed'; error: string; message?: string };
export type DictationEvent =
  | { kind: 'start' | 'noMatch' | 'end' }
  | { kind: 'result'; text: string; isFinal: boolean }
  | { kind: 'error'; error: string; message?: string }
  | { kind: 'cloudEnd'; failed: boolean };
export type DictationCommand =
  | { kind: 'reserve' | 'releaseReservation' | 'stop' | 'cancel'; owner: string }
  | { kind: 'begin'; config: DictationConfig }
  | { kind: 'background' }
  | ({ kind: 'execute' } & DictationScope)
  | ({ kind: 'ack'; outcome: DictationOutcome } & DictationScope)
  | { kind: 'event'; generation: string; epoch: string; event: DictationEvent };
export type DictationEffect = DictationScope & (
  | { action: 'load' | 'readContext' | 'suspendPlayback' | 'startCloud' | 'cancelCloud' | 'closeCapture' | 'stop' | 'abort' | 'checkIdle' | 'release' }
  | { action: 'requestPermission'; existing: boolean }
  | { action: 'startRecognition'; continuous: boolean; onDevice: boolean; monitoring: boolean; context: string[] }
  | { action: 'finishCloud'; recent: string[] }
  | { action: 'publishDraftAppend'; text: string }
  | { action: 'reportError'; error: string; message?: string | null }
);
export interface DictationLifecycleView {
  owner: string | null;
  generation: string | null;
  epoch: string;
  phase: ComposerDictationPhase;
  interimText: string;
  active: boolean;
  acceptsAudio: boolean;
}
export interface DictationUpdate { view: DictationLifecycleView; effects: DictationEffect[] }
export interface DictationAuthority {
  dispatch(command: string): boolean;
  takeUpdate(): string;
  setObserver(observer: { changed: () => void }): void;
}

export function getDictationAuthority(): DictationAuthority {
  // Keep old development builds on the service's unavailable path.
  const { dictationLifecycle } = require('./generated-entry') as typeof import('./generated-entry');
  return dictationLifecycle();
}
