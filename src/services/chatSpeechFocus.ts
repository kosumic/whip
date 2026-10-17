import { isSpeechInputActive } from './speechInputFocus';

type SpeechFocus = { hostId: string; paneId: string };
let focus: SpeechFocus | null = null;

export function setChatSpeechFocus(target: SpeechFocus | null): void {
  focus = target;
}

export function isChatSpeechActive(): boolean {
  return focus !== null || isSpeechInputActive();
}

export function isChatSpeechTarget(hostId: string, paneId: string): boolean {
  return focus?.hostId === hostId && focus.paneId === paneId;
}
