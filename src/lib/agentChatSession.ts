import type { TerminalSession } from '../terminalSessions';
import type { PaneInfo } from '../types';

export type ChatAgent = 'codex' | 'opencode';

const CHAT_AGENT_NAMES: Record<ChatAgent, string> = { codex: 'Codex', opencode: 'OpenCode' };

export function chatAgentDisplayName(agent: ChatAgent): string {
  return CHAT_AGENT_NAMES[agent];
}

export function isCodexPane(pane: PaneInfo | undefined): boolean {
  if (!pane) return false;
  if (pane.agent_session?.agent.toLowerCase() === 'codex') return true;
  return [pane.agent, pane.display_agent]
    .some(value => typeof value === 'string' && /(^|[^a-z])codex([^a-z]|$)/i.test(value));
}

export function isOpenCodePane(pane: PaneInfo | undefined): boolean {
  if (!pane) return false;
  if (pane.agent_session?.agent.toLowerCase() === 'opencode') return true;
  return [pane.agent, pane.display_agent].some(
    value =>
      typeof value === 'string' &&
      /(^|[^a-z])open\s*-?\s*code([^a-z]|$)/i.test(value),
  );
}

export function chatAgentForPane(pane: PaneInfo | undefined): ChatAgent | null {
  if (isCodexPane(pane)) return 'codex';
  if (isOpenCodePane(pane)) return 'opencode';
  return null;
}

export function activePaneForTerminal(
  panes: readonly PaneInfo[],
  sessions: readonly TerminalSession[],
  activeTerminalId: string | null,
): PaneInfo | undefined {
  const active = sessions.find(
    session => session.terminalId === activeTerminalId,
  );
  return panes.find(pane => pane.terminal_id === active?.terminalId);
}

export function agentChatControlState(
  pane: PaneInfo | undefined,
  busy: boolean,
  loading: boolean,
): { agent: ChatAgent; disabled: boolean; loading: boolean } | null {
  const agent = chatAgentForPane(pane);
  return agent ? { agent, disabled: busy || loading, loading } : null;
}
