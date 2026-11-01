import { useCallback, useRef } from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollViewInstance } from 'react-native';

/** Keep a shrinking horizontal row within its content without losing valid scroll positions. */
export function useHorizontalScrollBounds() {
  const ref = useRef<ScrollViewInstance>(null);
  const bounds = useRef({ viewportWidth: 0, contentWidth: 0, offset: 0 });

  const clampOffset = useCallback(() => {
    const { viewportWidth, contentWidth, offset } = bounds.current;
    if (viewportWidth <= 0) return;
    const next = Math.max(0, Math.min(offset, contentWidth - viewportWidth));
    if (next === offset) return;
    bounds.current.offset = next;
    ref.current?.scrollTo({ x: next, y: 0, animated: false });
  }, []);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    bounds.current.viewportWidth = event.nativeEvent.layout.width;
    clampOffset();
  }, [clampOffset]);

  const onContentSizeChange = useCallback((width: number, _height: number) => {
    bounds.current.contentWidth = width;
    clampOffset();
  }, [clampOffset]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    bounds.current.offset = event.nativeEvent.contentOffset.x;
  }, []);

  return { ref, onLayout, onContentSizeChange, onScroll, scrollEventThrottle: 16 };
}
