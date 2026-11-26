export const CHAT_WORKING_LABEL = 'Working';
export const CHAT_WORKING_SHIMMER_PERIOD_MS = 4_000;
export const CHAT_TOOL_SHIMMER_PERIOD_MS = 2_000;
const START_DELAY_MS = 600;
const SWEEP_MS = 1_000;

/** Codex's broad, left-to-right cosine highlight. */
export function chatShimmerOpacity(elapsedMs: number, index: number, length: number): number {
  'worklet';
  const halfWidth = Math.max(length * 0.1, 3);
  const sweep = Math.max(0, Math.min((elapsedMs - START_DELAY_MS) / SWEEP_MS, 1));
  const position = sweep * (length + 2 * halfWidth) - halfWidth;
  const distance = Math.min(Math.abs(index + 0.5 - position) / halfWidth, 1);
  const intensity = 0.5 * (1 + Math.cos(Math.PI * distance));
  return 0.5 + 0.5 * intensity;
}
