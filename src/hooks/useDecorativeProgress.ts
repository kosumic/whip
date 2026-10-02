import { useCallback, useEffect } from 'react';
import { useFrameCallback, useSharedValue, type FrameInfo } from 'react-native-reanimated';

export const DECORATIVE_FRAMES_PER_SECOND = 30;

/** Limit style updates, not animation speed. All instances share frame boundaries. */
export function useDecorativeProgress(
  enabled: boolean,
  durationMs: number,
  reverse = true,
  framesPerSecond = DECORATIVE_FRAMES_PER_SECOND,
) {
  const progress = useSharedValue(0);
  const timing = useSharedValue({ startedAt: -1, lastFrame: -1 });
  const callback = useFrameCallback(useCallback(({ timestamp }: FrameInfo) => {
    'worklet';
    const frame = Math.floor(timestamp * framesPerSecond / 1000);
    if (frame === timing.value.lastFrame) return;
    const startedAt = timing.value.startedAt < 0 ? timestamp : timing.value.startedAt;
    timing.value = { startedAt, lastFrame: frame };
    const phase = (timestamp - startedAt) / durationMs;
    if (reverse) {
      const cycle = phase % 2;
      const position = cycle <= 1 ? cycle : 2 - cycle;
      // Preserve the existing quadratic ease-in/ease-out breathing curve.
      progress.value = position < 0.5
        ? 2 * position * position
        : 1 - ((-2 * position + 2) ** 2) / 2;
    } else {
      progress.value = phase % 1;
    }
  }, [durationMs, framesPerSecond, progress, reverse, timing]), false);

  useEffect(() => {
    timing.value = { startedAt: -1, lastFrame: -1 };
    progress.value = 0;
    callback.setActive(enabled);
    return () => callback.setActive(false);
  }, [callback, durationMs, enabled, progress, reverse, timing]);

  return progress;
}
