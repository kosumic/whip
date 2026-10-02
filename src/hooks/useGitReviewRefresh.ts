import { useEffect, useEffectEvent, useRef } from 'react';
import { AppState } from 'react-native';

/** Refresh only on lifecycle transitions, never on every snapshot or render. */
export function useGitReviewRefresh(enabled: boolean, agentWorking: boolean, onRefresh: () => void) {
  const refresh = useEffectEvent(() => { if (enabled) onRefresh(); });
  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', next => {
      if (next === 'active' && previous !== 'active') refresh();
      previous = next;
    });
    return () => subscription.remove();
  }, []);
  const wasWorking = useRef(agentWorking);
  useEffect(() => {
    if (wasWorking.current && !agentWorking) refresh();
    wasWorking.current = agentWorking;
  }, [agentWorking]);
}
