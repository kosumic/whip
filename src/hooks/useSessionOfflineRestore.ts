import { useEffect, useEffectEvent, useRef } from 'react';

import type { SessionRuntimeStore } from './sessionRuntimeTypes';
import { herdrSnapshotCache } from '../services/herdrSnapshotCache';
import { reportBackgroundFailure } from '../services/backgroundOperations';

/** Transport stored metadata into AppCore once per session incarnation. */
export function useSessionOfflineRestore({
  state,
  appCore,
  commitAppCore,
  sessionProfilesRef,
}: Pick<SessionRuntimeStore, 'state' | 'appCore' | 'commitAppCore' | 'sessionProfilesRef'>) {
  const loads = useRef(new Map<string, symbol>());
  useEffect(() => {
    const current = new Set(state.sessions.map(session => session.id));
    for (const id of loads.current.keys()) {
      if (!current.has(id)) loads.current.delete(id);
    }
    for (const session of state.sessions) {
      if (sessionProfilesRef.current.get(session.hostId)?.herdrEnabled === false) {
        loads.current.delete(session.id);
        continue;
      }
      if (loads.current.has(session.id)) continue;
      const token = Symbol(session.id);
      loads.current.set(session.id, token);
      const load = herdrSnapshotCache.load(session.hostId).then(blob => {
        if (!blob || loads.current.get(session.id) !== token
          || sessionProfilesRef.current.get(session.hostId)?.herdrEnabled === false) return;
        commitAppCore(appCore.restoreCachedHost(session.id, blob));
      });
      reportBackgroundFailure(load, 'herdr-snapshot-cache-load');
    }
  }, [appCore, commitAppCore, sessionProfilesRef, state.sessions]);
  const cancelLoads = useEffectEvent(() => loads.current.clear());
  useEffect(() => () => cancelLoads(), []);
}
