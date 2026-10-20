import type { NativeAgentChatBinding } from 'react-native-whip-ssh';
import type { AgentChatState } from '../agentChat';
import type { PaneInfo, TabInfo } from '../types';

export type TranscriptTitleIdentity = Pick<NativeAgentChatBinding, 'paneId' | 'terminalId' | 'agent' | 'sessionId'>;
export type TranscriptTitlePane = Pick<PaneInfo, 'pane_id' | 'terminal_id' | 'agent_session'>;

function identityKey(host: string, binding: TranscriptTitleIdentity): string {
  return JSON.stringify([host, binding.paneId, binding.terminalId, binding.agent, binding.sessionId]);
}

export function transcriptTitleKey(host: string, pane: TranscriptTitlePane): string | null {
  const session = pane.agent_session;
  if (session?.kind !== 'id' || !session.value.trim()) return null;
  return identityKey(host, {
    paneId: pane.pane_id, terminalId: pane.terminal_id,
    agent: session.agent.toLowerCase() as TranscriptTitleIdentity['agent'], sessionId: session.value.trim(),
  });
}

/** Display metadata only. Neither observing nor reading a title opens a transcript. */
export class TranscriptTabTitles {
  private readonly titles = new Map<string, { host: string; title: string }>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly allListeners = new Set<() => void>();

  observe(host: string, pane: TranscriptTitlePane, binding: TranscriptTitleIdentity, state: AgentChatState): boolean {
    if (!transcriptTitleKey(host, pane) || pane.pane_id !== binding.paneId || pane.terminal_id !== binding.terminalId ||
      pane.agent_session?.agent.toLowerCase() !== binding.agent ||
      pane.agent_session.value.trim() !== binding.sessionId) return false;
    return this.observeBinding(host, binding, state);
  }

  observeBinding(host: string, binding: TranscriptTitleIdentity, state: AgentChatState): boolean {
    const key = identityKey(host, binding);
    const info = state.transcript.info;
    const title = state.sessionId === binding.sessionId &&
      state.transcript.sessionId === binding.sessionId && info?.id === binding.sessionId
      ? info.title?.trim() : undefined;
    if (!title) return this.remove(key);
    if (this.titles.get(key)?.title === title) return false;
    this.titles.set(key, { host, title });
    this.notify(key);
    return true;
  }

  title(key: string | null): string | undefined {
    return key ? this.titles.get(key)?.title : undefined;
  }

  subscribe(key: string | null, listener: () => void): () => void {
    if (!key) return () => undefined;
    let listeners = this.listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
    };
  }

  subscribeAll(listener: () => void): () => void {
    this.allListeners.add(listener);
    return () => this.allListeners.delete(listener);
  }

  clear(): void {
    for (const key of this.titles.keys()) this.remove(key);
  }

  retain(host: string, panes: readonly TranscriptTitlePane[]): void {
    const retained = new Set(panes.map(pane => transcriptTitleKey(host, pane)));
    for (const [key, value] of this.titles) {
      if (value.host === host && !retained.has(key)) this.remove(key);
    }
  }

  label(host: string, tab: TabInfo, panes: readonly PaneInfo[], activeTerminalId: string | null): string {
    const fallback = tab.label || tab.tab_id;
    // Unknown origins on old Herdr servers must preserve pre-existing manual names.
    if (tab.label_is_custom !== false) return fallback;
    const candidates = panes.filter(pane => pane.tab_id === tab.tab_id && pane.workspace_id === tab.workspace_id);
    const pane = candidates.find(item => item.terminal_id === activeTerminalId) ||
      candidates.find(item => item.focused) || candidates[0];
    return this.title(pane ? transcriptTitleKey(host, pane) : null) || fallback;
  }

  private remove(key: string): boolean {
    if (!this.titles.delete(key)) return false;
    this.notify(key);
    return true;
  }

  private notify(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) listener();
    for (const listener of this.allListeners) listener();
  }
}
