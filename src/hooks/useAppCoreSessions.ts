import { useCallback, useRef, useState } from 'react';
import { replaceEqualDeep } from '@tanstack/react-query';
import type { AppCoreProjection } from 'react-native-whip-ssh';

/** Share unchanged native data and prepare each revision once before React replays it. */
export function useAppCoreSessions(
  initial: () => AppCoreProjection = () => ({ revision: 0, sessions: [] }),
) {
  const [state, setState] = useState(initial);
  const prepared = useRef(state);
  const project = useCallback((view: AppCoreProjection) => {
    // Rust advances this revision for host changes as well as local selection.
    // Decoding an unchanged snapshot must not invalidate the entire app tree.
    if (prepared.current.revision >= view.revision) return;
    const next = replaceEqualDeep(prepared.current, view);
    prepared.current = next;
    setState(current => current.revision >= next.revision ? current : next);
  }, []);
  return { state, project };
}
