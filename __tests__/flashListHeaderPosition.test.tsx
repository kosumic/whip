import React, { createRef } from 'react';
import { Platform, type NativeScrollEvent } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { FlashListRef } from '@shopify/flash-list';
import { RecyclerViewManager } from '@shopify/flash-list/dist/recyclerview/RecyclerViewManager';
import { useRecyclerViewController } from '@shopify/flash-list/dist/recyclerview/hooks/useRecyclerViewController';

const VIEWPORT = { width: 320, height: 400 };
const ROW_HEIGHT = 100;
const FOOTER_HEIGHT = 64;
const HEADER_HEIGHTS = [80, 120, 80, 120, 80];
const DATA = Array.from({ length: 20 }, (_, index) => `message-${index}`);

beforeAll(() => { jest.replaceProperty(Platform, 'OS', 'android'); });
afterAll(() => { jest.restoreAllMocks(); });

// Exercise FlashList's actual controller and layout manager. Only the native
// scroller is replaced: it clamps offsets when content shrinks, as Android does.
function listGeometry(distanceFromEnd: number | null) {
  const manager = new RecyclerViewManager({
    data: DATA,
    keyExtractor: item => item,
    renderItem: () => null,
    maintainVisibleContentPosition: { startRenderingFromBottom: true },
  });
  manager.updateLayoutParams(VIEWPORT, HEADER_HEIGHTS[0]);
  const measurements = DATA.map((_, index) => ({
    index, dimensions: { width: VIEWPORT.width, height: ROW_HEIGHT },
  }));
  manager.modifyChildrenLayout(measurements, DATA.length);
  manager.modifyChildrenLayout(measurements, DATA.length);
  manager.isFirstPaintOnUiComplete = true;

  const maximumOffset = () => manager.firstItemOffset
    + manager.getChildContainerDimensions().height + FOOTER_HEIGHT - VIEWPORT.height;
  let offset = distanceFromEnd === null ? 500 : maximumOffset() - distanceFromEnd;
  const moveTo = (next: number) => { offset = Math.max(0, Math.min(next, maximumOffset())); };
  manager.updateScrollOffset(offset);
  let controller: ReturnType<typeof useRecyclerViewController<string>>;
  const scroller = { current: {
    scrollTo: ({ y }: { y: number }) => moveTo(y),
    scrollToEnd: () => moveTo(maximumOffset()),
  } };
  const anchor = { current: { scrollBy: (delta: number) => moveTo(offset + delta) } };
  const nativeEvent = (): NativeScrollEvent => ({
    contentOffset: { x: 0, y: offset },
    contentSize: { width: VIEWPORT.width, height: maximumOffset() + VIEWPORT.height },
    contentInset: { top: 0, bottom: 0, left: 0, right: 0 },
    layoutMeasurement: VIEWPORT,
    zoomScale: 1,
  });
  const nativeScrollEventRef = { current: nativeEvent() };
  const ref = createRef<FlashListRef<string>>();
  function Harness() {
    controller = useRecyclerViewController(manager, ref, scroller as never, anchor, nativeScrollEventRef);
    return null;
  }
  let renderer: ReactTestRenderer;
  act(() => { renderer = create(<Harness />); });
  act(() => { controller.computeFirstVisibleIndexForOffsetCorrection(); });
  const visibleIndex = manager.computeVisibleIndices().startIndex;
  const rowPosition = () => manager.firstItemOffset + manager.getLayout(visibleIndex).y - offset;
  return {
    rowPosition,
    resizeHeader(height: number) {
      manager.updateLayoutParams(VIEWPORT, height);
      moveTo(offset);
      // Chat's content-size handler may already have followed the new end
      // before FlashList applies its layout correction.
      if (distanceFromEnd === 0) scroller.current.scrollToEnd();
      act(() => { controller.applyOffsetCorrection(); });
      nativeScrollEventRef.current = nativeEvent();
      manager.updateScrollOffset(offset);
      act(() => { controller.computeFirstVisibleIndexForOffsetCorrection(); });
    },
    dispose() {
      act(() => { renderer.unmount(); });
      manager.dispose();
    },
  };
}

test.each([null, 0, 20])('keeps a visible message stationary across header resizes (distance from bottom: %s)', distanceFromEnd => {
  const list = listGeometry(distanceFromEnd);
  try {
    const initialPosition = list.rowPosition();
    for (const height of HEADER_HEIGHTS.slice(1)) {
      list.resizeHeader(height);
      expect(list.rowPosition()).toBe(initialPosition);
    }
  } finally {
    list.dispose();
  }
});
