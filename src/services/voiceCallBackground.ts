export const VOICE_CALL_BACKGROUND_TASK = 'WhipVoiceCall';

const calls = new Map<string, { done: Promise<void>; finish: () => void }>();

/** The native call owns execution; JS keeps its task alive through call cleanup. */
export function retainVoiceCallBackground(token: string): () => void {
  let finish!: () => void;
  const call = { done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() };
  calls.set(token, call);
  return () => {
    if (calls.get(token) !== call) return;
    calls.delete(token);
    call.finish();
  };
}

export async function runVoiceCallBackground({ token }: { token: string }): Promise<void> {
  // A cancelled startup may finish before native invokes the registered task.
  await calls.get(token)?.done;
}
