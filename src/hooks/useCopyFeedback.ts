import { useCallback, useEffect, useRef, useState } from 'react';
import { copyTextWithHaptic, hapticCopySuccess } from '../services/interactionFeedback';

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

  const copyText = useCallback((text: string) => {
    copyTextWithHaptic(text);
    showCopied();
  }, [showCopied]);

  // The native code-block control writes the clipboard before this event.
  const onNativeCopy = useCallback(() => {
    hapticCopySuccess();
    showCopied();
  }, [showCopied]);

  return { copied, copyText, onNativeCopy };
}
