import { useCallback, useContext, useEffect } from 'react';
import { useFrameCallback, useSharedValue, type FrameInfo } from 'react-native-reanimated';
import { AnimationVisibilityContext } from '../lib/animationVisibility';

export const DECORATIVE_FRAMES_PER_SECOND = 30;
export const SPINNER_FRAMES_PER_SECOND = 60;
// Native schedulers stop in the background. Treat a long gap as suspension,
// retaining the pose instead of advancing by the time spent away from the app.
const SUSPENDED_FRAME_GAP_MS = 250;

/** Limit style updates, not animation speed. All instances share frame boundaries. */
export function useDecorativeProgress(
  enabled: boolean,
  durationMs: number,
  reverse = true,
  framesPerSecond = DECORATIVE_FRAMES_PER_SECOND,
) {
  const visible = useContext(AnimationVisibilityContext);
  const progress = useSharedValue(0);
  const timing = useSharedValue({ elapsed: 0, previousTimestamp: -1, lastFrame: -1 });
  const callback = useFrameCallback(useCallback(({ timestamp }: FrameInfo) => {
    'worklet';
    const previous = timing.value;
    const frame = Math.floor(timestamp * framesPerSecond / 1000);
    if (frame === previous.lastFrame) return;
    const delta = previous.previousTimestamp < 0 ? 0 : timestamp - previous.previousTimestamp;
    const elapsed = previous.elapsed + (delta > SUSPENDED_FRAME_GAP_MS ? 1000 / framesPerSecond : delta);
    timing.value = { elapsed, previousTimestamp: timestamp, lastFrame: frame };
    const phase = elapsed / durationMs;
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
    callback.setActive(enabled && visible);
    return () => {
      callback.setActive(false);
      timing.value = { ...timing.value, previousTimestamp: -1, lastFrame: -1 };
    };
  }, [callback, durationMs, enabled, progress, reverse, timing, visible]);

  useEffect(() => {
    if (!enabled) {
      timing.value = { elapsed: 0, previousTimestamp: -1, lastFrame: -1 };
      progress.value = 0;
    }
  }, [enabled, progress, timing]);

  return progress;
}
