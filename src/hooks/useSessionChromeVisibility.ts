import { useEffect, useState } from 'react';

export const SESSION_CHROME_RESTORE_DELAY_MS = 120;

/** Delay only chrome restoration across a focus handoff, never IME geometry. */
export function useSessionChromeVisibility(keyboardVisible: boolean) {
  const [hidden, setHidden] = useState(keyboardVisible);
  useEffect(() => {
    if (keyboardVisible) {
      setHidden(true);
      return;
    }
    if (!hidden) return;
    const timer = setTimeout(() => setHidden(false), SESSION_CHROME_RESTORE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [hidden, keyboardVisible]);
  return !keyboardVisible && !hidden;
}
