export const CHAT_WORKING_LABEL = 'Working';
export const CHAT_WORKING_SHIMMER_PERIOD_MS = 4_000;
const START_DELAY_MS = 600;
const SWEEP_MS = 1_000;
const HALF_WIDTH = Math.max(CHAT_WORKING_LABEL.length * 0.1, 3);

/** Codex's broad, left-to-right cosine highlight; the elapsed time stays static. */
export function workingShimmerOpacity(phase: number, index: number): number {
  'worklet';
  const sweep = Math.max(0, Math.min((phase * CHAT_WORKING_SHIMMER_PERIOD_MS - START_DELAY_MS) / SWEEP_MS, 1));
  const position = sweep * (CHAT_WORKING_LABEL.length + 2 * HALF_WIDTH) - HALF_WIDTH;
  const distance = Math.min(Math.abs(index + 0.5 - position) / HALF_WIDTH, 1);
  const intensity = 0.5 * (1 + Math.cos(Math.PI * distance));
  return 0.5 + 0.5 * intensity;
}
