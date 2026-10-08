import { useCallback, useEffect, useRef, useState } from 'react';

export const SCROLL_IDLE_MS = 200;

export function useScrollActivity() {
  const [scrolling, setScrolling] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelIdle = useCallback(() => {
    if (idleTimer.current !== null) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
  }, []);
  useEffect(() => cancelIdle, [cancelIdle]);

  const beginScroll = useCallback(() => {
    cancelIdle();
    setScrolling(true);
  }, [cancelIdle]);

  const endScroll = useCallback(() => {
    cancelIdle();
    idleTimer.current = setTimeout(() => {
      idleTimer.current = null;
      setScrolling(false);
    }, SCROLL_IDLE_MS);
  }, [cancelIdle]);

  const resetScroll = useCallback(() => {
    cancelIdle();
    setScrolling(false);
  }, [cancelIdle]);

  return { scrolling, beginScroll, endScroll, resetScroll };
}
