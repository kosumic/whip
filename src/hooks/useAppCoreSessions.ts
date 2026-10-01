import { useCallback, useState } from 'react';
import type { AppCoreProjection } from 'react-native-whip-ssh';

/** Cache the native object itself so transition replays preserve its identity. */
export function useAppCoreSessions(
  initial: () => AppCoreProjection = () => ({ revision: 0, sessions: [] }),
) {
  const [state, setState] = useState(initial);
  const project = useCallback((view: AppCoreProjection) => setState(view), []);
  return { state, project };
}
