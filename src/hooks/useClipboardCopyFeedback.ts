import { useEffect } from 'react';
import { AppState } from 'react-native';
import { observeClipboardCopyFeedback } from '../services/interactionFeedback';

/** Native terminal and chat copy menus do not all expose copy callbacks. */
export function useClipboardCopyFeedback(visible: boolean): void {
  useEffect(() => {
    if (!visible) return;

    let stopObserving: (() => void) | undefined;
    const update = (state: typeof AppState.currentState) => {
      stopObserving?.();
      stopObserving = state === 'active' ? observeClipboardCopyFeedback() : undefined;
    };
    update(AppState.currentState);
    const subscription = AppState.addEventListener('change', update);
    return () => {
      subscription.remove();
      stopObserving?.();
    };
  }, [visible]);
}
