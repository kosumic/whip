export const HERD_TAB_CLOSE_DISTANCE = 96;
export const HERD_TAB_MAX_DRAG = 144;

export function shouldClaimHerdTabSwipe(
  dx: number,
  dy: number,
): boolean {
  if (Math.abs(dx) < 10 || Math.abs(dx) <= Math.abs(dy) * 1.2) return false;
  return dx < 0;
}

export function herdTabSwipeOffset(dx: number): number {
  return Math.max(-HERD_TAB_MAX_DRAG, Math.min(0, dx));
}

export function shouldCloseHerdTabSwipe(
  dx: number,
  vx: number,
): boolean {
  return dx <= -HERD_TAB_CLOSE_DISTANCE || (dx <= -24 && vx <= -0.65);
}
