export const HERD_TAB_REVEAL_DISTANCE = 96;
export const HERD_TAB_MAX_DRAG = 144;
export const HERD_TAB_ACTIONS_WIDTH = 300;

export function shouldClaimHerdTabSwipe(dx: number, dy: number): boolean {
  if (Math.abs(dx) < 10 || Math.abs(dx) <= Math.abs(dy) * 1.2) return false;
  return dx < 0;
}

export function herdTabSwipeOffset(
  dx: number,
  maxDrag = HERD_TAB_MAX_DRAG,
): number {
  return Math.max(-maxDrag, Math.min(0, dx));
}

export function shouldRevealHerdTabSwipe(dx: number, vx: number): boolean {
  return dx <= -HERD_TAB_REVEAL_DISTANCE || (dx <= -24 && vx <= -0.65);
}

export function shouldDismissHerdTabSwipe(dx: number, vx: number): boolean {
  return shouldRevealHerdTabSwipe(-dx, -vx);
}
