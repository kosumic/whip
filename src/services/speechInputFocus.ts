let active = false;
const listeners = new Set<() => void>();

export const isSpeechInputActive = (): boolean => active;
export const subscribeSpeechInput = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function setSpeechInputActive(value: boolean): void {
  if (active === value) return;
  active = value;
  for (const listener of listeners) listener();
}
