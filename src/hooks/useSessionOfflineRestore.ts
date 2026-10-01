import { useEffect, useEffectEvent, useRef } from 'react';

import type { SessionRuntimeStore } from './sessionRuntimeTypes';
import { herdrSnapshotCache } from '../services/herdrSnapshotCache';
import { reportBackgroundFailure } from '../services/backgroundOperations';

/** Transport stored metadata into AppCore once per session incarnation. */
export function useSessionOfflineRestore({
  state,
  appCore,
  commitAppCore,
}: Pick<SessionRuntimeStore, 'state' | 'appCore' | 'commitAppCore'>) {
  const loads = useRef(new Map<string, symbol>());
  useEffect(() => {
    const current = new Set(state.sessions.map(session => session.id));
    for (const id of loads.current.keys()) {
      if (!current.has(id)) loads.current.delete(id);
    }
    for (const session of state.sessions) {
      if (loads.current.has(session.id)) continue;
      const token = Symbol(session.id);
      loads.current.set(session.id, token);
      const load = herdrSnapshotCache.load(session.hostId).then(blob => {
        if (!blob || loads.current.get(session.id) !== token) return;
        commitAppCore(appCore.restoreCachedHost(session.id, blob));
      });
      reportBackgroundFailure(load, 'herdr-snapshot-cache-load');
    }
  }, [appCore, commitAppCore, state.sessions]);
  const cancelLoads = useEffectEvent(() => loads.current.clear());
  useEffect(() => () => cancelLoads(), []);
}
