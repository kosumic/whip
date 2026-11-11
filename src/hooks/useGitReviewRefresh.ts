import { useEffect, useEffectEvent } from 'react';
import { AppState } from 'react-native';

/** Revalidate lazily on resume; agent completion is handled by runtime events. */
export function useGitReviewRefresh(enabled: boolean, onRefresh: () => void) {
  const refresh = useEffectEvent(() => { if (enabled) onRefresh(); });
  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', next => {
      if (next === 'active' && previous !== 'active') refresh();
      previous = next;
    });
    return () => subscription.remove();
  }, []);
}
