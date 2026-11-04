import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { NativeAppCore } from 'react-native-whip-ssh';
import type { SessionRuntimeStore } from './sessionRuntimeTypes';
import { chatAgentForPane } from '../lib/agentChatSession';
import {
  agentTranscriptService,
  transcriptCacheHostAvailability,
  type TranscriptCacheHost,
  type TranscriptCacheTarget,
} from '../services/NativeTranscriptService';

export function useTranscriptCache(
  { state, runtimesRef }: Pick<SessionRuntimeStore, 'state' | 'runtimesRef'>,
  core: NativeAppCore,
  capacity: number,
): void {
  const ownership = useRef<ReturnType<typeof agentTranscriptService.claimCacheOwnership> | null>(null);
  const residency = useSyncExternalStore(agentTranscriptService.subscribeResidency, agentTranscriptService.residencyVersion);
  useEffect(() => {
    const lease = agentTranscriptService.claimCacheOwnership();
    ownership.current = lease;
    return () => {
      ownership.current = null;
      lease.release();
    };
  }, [core, runtimesRef]);
  useEffect(() => {
    if (!ownership.current?.isCurrent()) return;
    const hosts: TranscriptCacheHost[] = [];
    const targets = new Map<string, TranscriptCacheTarget>();
    for (const session of state.sessions) {
      const transport = runtimesRef.current.get(session.id)?.client.activeNative;
      if (!transport) continue;
      const host = transport.hostState();
      hosts.push({ hostSessionId: session.id, state: host, transport });
      const availability = transcriptCacheHostAvailability(host);
      if (availability === 'unavailable') continue;
      for (const pane of host.snapshot?.panes ?? []) {
        const identity = pane.agent_session;
        const agent = identity && chatAgentForPane(pane);
        if (!agent || !identity?.value.trim() ||
          (identity.kind !== 'id' && !(agent === 'pi' && identity.kind === 'path'))) continue;
        const needsAttention = pane.agent_status === 'working' || pane.agent_status === 'blocked' || pane.agent_status === 'done';
        targets.set(JSON.stringify([session.id, pane.terminal_id]), {
          hostSessionId: session.id, terminalId: pane.terminal_id,
          // Seen/idle chats stay eligible for residency after navigation releases
          // their foreground pin. Only attention rows start speculative loads.
          agent, sessionId: identity.value.trim(), transport, preload: availability === 'load' && needsAttention,
        });
      }
    }
    // Filtering in the UI must not change the device-wide cache ranking.
    const ranked: TranscriptCacheTarget[] = [];
    for (const item of core.herdView([]).agents) {
      const key = JSON.stringify([item.hostId, item.agent.terminal_id]);
      const target = targets.get(key);
      if (!target) continue;
      ranked.push(target);
      targets.delete(key);
    }
    // Older servers can expose a transcript identity before an agent row.
    ranked.push(...targets.values());
    agentTranscriptService.reconcileCache(capacity, ranked, hosts);
  }, [capacity, core, state, runtimesRef, residency]);
}
