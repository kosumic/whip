import { useCallback, useEffect, useRef, useState } from 'react';

export const COPY_FEEDBACK_MS = 1_500;

export function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const showCopied = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setCopied(false);
    }, COPY_FEEDBACK_MS);
  }, []);

  return { copied, showCopied };
}
