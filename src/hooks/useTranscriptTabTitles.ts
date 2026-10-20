import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import type { AgentChatState } from '../agentChat';
import type { ChatAgent } from '../lib/agentChatSession';
import type { TranscriptTabTitles } from '../lib/transcriptTabTitles';
import { agentTranscriptService } from '../services/NativeTranscriptService';
import type { PaneInfo, TabInfo } from '../types';

export function useTranscriptTabTitles(
  host: string,
  panes: readonly PaneInfo[],
  tabs: readonly TabInfo[],
  activeTerminalId: string | null,
  saved: { host: string; paneId: string; agent: ChatAgent; state: AgentChatState } | null,
): TranscriptTabTitles {
  const cache = agentTranscriptService.titles;
  const subscribe = useCallback((listener: () => void) => cache.subscribeAll(listener), [cache]);
  const snapshot = useCallback(() => JSON.stringify(
    tabs.map(tab => cache.label(host, tab, panes, activeTerminalId)),
  ), [cache, host, tabs, panes, activeTerminalId]);
  useSyncExternalStore(subscribe, snapshot, snapshot);

  useLayoutEffect(() => {
    cache.retain(host, panes);
    if (saved?.host === host) {
      const pane = panes.find(item => item.pane_id === saved.paneId);
      if (pane) cache.observe(host, pane, {
        paneId: saved.paneId, terminalId: pane.terminal_id,
        agent: saved.agent, sessionId: saved.state.sessionId,
      }, saved.state);
    }
  }, [cache, host, panes, saved]);

  return cache;
}
