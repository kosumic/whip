import {
  HERD_TAB_REVEAL_DISTANCE,
  HERD_TAB_MAX_DRAG,
  HERD_TAB_ACTIONS_WIDTH,
  herdTabSwipeOffset,
  shouldClaimHerdTabSwipe,
  shouldRevealHerdTabSwipe,
  shouldDismissHerdTabSwipe,
} from '../src/lib/herdTabSwipeActions';

describe('Herd tab swipe actions', () => {
  it('claims only deliberate leftward horizontal movement', () => {
    expect(shouldClaimHerdTabSwipe(-20, 2)).toBe(true);
    expect(shouldClaimHerdTabSwipe(20, 2)).toBe(false);
    expect(shouldClaimHerdTabSwipe(-20, 19)).toBe(false);
    expect(shouldClaimHerdTabSwipe(-8, 0)).toBe(false);
  });

  it('follows leftward movement within a bounded reveal', () => {
    expect(herdTabSwipeOffset(-40)).toBe(-40);
    expect(herdTabSwipeOffset(-300)).toBe(-HERD_TAB_MAX_DRAG);
    expect(herdTabSwipeOffset(-280, HERD_TAB_ACTIONS_WIDTH)).toBe(-280);
    expect(herdTabSwipeOffset(40)).toBe(0);
  });

  it('reveals the action tray after enough distance or a deliberate left fling', () => {
    expect(shouldRevealHerdTabSwipe(-HERD_TAB_REVEAL_DISTANCE, 0)).toBe(true);
    expect(shouldRevealHerdTabSwipe(-HERD_TAB_REVEAL_DISTANCE + 1, 0)).toBe(
      false,
    );
    expect(shouldRevealHerdTabSwipe(-30, -0.8)).toBe(true);
    expect(shouldRevealHerdTabSwipe(-20, -0.8)).toBe(false);
    expect(shouldRevealHerdTabSwipe(20, -0.8)).toBe(false);
  });

  it('dismisses the tray on a deliberate rightward swipe', () => {
    expect(shouldDismissHerdTabSwipe(HERD_TAB_REVEAL_DISTANCE, 0)).toBe(true);
    expect(shouldDismissHerdTabSwipe(30, 0.8)).toBe(true);
    expect(shouldDismissHerdTabSwipe(20, 0.8)).toBe(false);
    expect(shouldDismissHerdTabSwipe(-30, -0.8)).toBe(false);
  });
});
