import type { VoiceSessionCoordinatorLike } from './generated/whip_ssh';

export type SessionEffect = { id: string; action: 'prepare' | 'start' | 'close' | 'end' | 'error'; error?: string | null };
export type SessionEffectBatch = { version: number; effects: SessionEffect[] };
export type SessionAdmission = { id: string; attached: boolean; error?: string | null };
export type SessionObservation = { revision: string; view: Record<string, unknown> | null; ended: boolean };
export interface VoiceSessionAuthority {
  request(request: string): string;
  takeEffects(): string;
  acknowledge(id: string, event: string): void;
  end(id: string, error?: string): void;
  isCurrent(id: string): boolean;
  phase(id: string): string;
  activeId(): string | undefined;
  setLocked(locked: boolean): void;
  retainHosts(hosts: string[]): void;
  submitContext(id: string, text: string): void;
  sameTarget(left: string, right: string): boolean;
  setObserver(observer: { changed(): void }): void;
}
let native: VoiceSessionCoordinatorLike | undefined;
/** Loading a presenter alone must not initialize native audio or a cloud client. */
export function nativeVoiceSessions(): VoiceSessionCoordinatorLike {
  if (!native) {
    const { voiceSessionCoordinator } = require('./generated-entry') as typeof import('./generated-entry');
    native = voiceSessionCoordinator();
  }
  return native;
}
export function voiceSourceIdentity(source: { runtimeId: string; incarnation: bigint; terminalId: string; paneId: string; agent: string; targetKey: string }) {
  return { runtimeId: source.runtimeId, incarnation: source.incarnation.toString(), terminalId: source.terminalId, paneId: source.paneId, agent: source.agent, targetKey: source.targetKey };
}
