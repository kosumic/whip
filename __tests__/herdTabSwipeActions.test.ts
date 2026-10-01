import {
  HERD_TAB_CLOSE_DISTANCE,
  HERD_TAB_MAX_DRAG,
  herdTabSwipeOffset,
  shouldClaimHerdTabSwipe,
  shouldCloseHerdTabSwipe,
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
    expect(herdTabSwipeOffset(40)).toBe(0);
  });

  it('closes after enough distance or a deliberate left fling', () => {
    expect(shouldCloseHerdTabSwipe(-HERD_TAB_CLOSE_DISTANCE, 0)).toBe(true);
    expect(shouldCloseHerdTabSwipe(-HERD_TAB_CLOSE_DISTANCE + 1, 0)).toBe(
      false,
    );
    expect(shouldCloseHerdTabSwipe(-30, -0.8)).toBe(true);
    expect(shouldCloseHerdTabSwipe(-20, -0.8)).toBe(false);
    expect(shouldCloseHerdTabSwipe(20, -0.8)).toBe(false);
  });
});
