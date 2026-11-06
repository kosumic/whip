import { useCallback, useState } from 'react';
import type { AppCoreProjection } from 'react-native-whip-ssh';

/** Cache the native object itself so transition replays preserve its identity. */
export function useAppCoreSessions(
  initial: () => AppCoreProjection = () => ({ revision: 0, sessions: [] }),
) {
  const [state, setState] = useState(initial);
  const project = useCallback((view: AppCoreProjection) => {
    // Rust advances this revision for host changes as well as local selection.
    // Decoding an unchanged snapshot must not invalidate the entire app tree.
    setState(current => current.revision >= view.revision ? current : view);
  }, []);
  return { state, project };
}
