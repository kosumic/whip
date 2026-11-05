/** Presence and mutation events, without keeping a saved credential in JS. */
export function createMockOpenAiVoiceCredentials() {
  const before = new Set<() => void>();
  const after = new Set<() => void>();
  let updating = false;
  const hasOpenAiVoiceKey = jest.fn(() => Promise.resolve(false));
  const update = (saved: boolean) => {
    updating = true;
    for (const listener of before) listener();
    hasOpenAiVoiceKey.mockResolvedValue(saved);
    updating = false;
    for (const listener of after) listener();
    return Promise.resolve();
  };
  return {
    hasOpenAiVoiceKey,
    isOpenAiVoiceCredentialUpdating: () => updating,
    saveOpenAiVoiceKey: jest.fn((_value: string) => update(true)),
    removeOpenAiVoiceKey: jest.fn(() => update(false)),
    onOpenAiVoiceCredentialChange: jest.fn((listener: () => void, timing = 'before') => {
      const listeners = timing === 'after' ? after : before;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
  };
}
