import { useEffect, useEffectEvent, useRef } from 'react';
import type { NativeAppCore } from 'react-native-whip-ssh';
import type { SessionRuntimeStore } from './sessionRuntimeTypes';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import {
  agentTranscriptService,
  type TranscriptCacheHost,
} from '../services/NativeTranscriptService';

export function useTranscriptCache(
  { state, runtimesRef }: Pick<SessionRuntimeStore, 'state' | 'runtimesRef'>,
  core: NativeAppCore,
  capacity: number,
): void {
  const ownership = useRef<ReturnType<typeof agentTranscriptService.claimCacheOwnership> | null>(null);
  const reconcile = useEffectEvent(() => {
    if (!ownership.current?.isCurrent()) return;
    const hosts: TranscriptCacheHost[] = [];
    for (const session of state.sessions) {
      const transport = runtimesRef.current.get(session.id)?.client.activeNative;
      if (!transport) continue;
      const host = transport.hostState();
      hosts.push({ hostSessionId: session.id, state: host, transport });
    }
    agentTranscriptService.reconcileCache(core, ownership.current.token, capacity, hosts);
  });
  useEffect(() => {
    const lease = agentTranscriptService.claimCacheOwnership();
    ownership.current = lease;
    let disposed = false;
    let queued = false;
    const unsubscribe = agentTranscriptService.subscribeResidency(() => {
      if (disposed || queued || !lease.isCurrent()) return;
      queued = true;
      // Pins and subscriptions change together during a screen commit. Reconcile
      // their final state without turning cache bookkeeping into app-root renders.
      reportBackgroundFailure(Promise.resolve().then(() => {
        queued = false;
        if (!disposed && lease.isCurrent()) reconcile();
      }), 'transcript-cache-reconcile');
    });
    return () => {
      disposed = true;
      unsubscribe();
      ownership.current = null;
      lease.release();
    };
  }, [core, runtimesRef]);
  useEffect(() => { reconcile(); }, [capacity, core, state, runtimesRef]);
}
