import type { RuntimeAgentKind } from 'react-native-whip-ssh';
import type { TerminalSession } from '../terminalSessions';
import type { PaneInfo } from '../types';

export type ChatAgent = RuntimeAgentKind;

const CHAT_AGENT_NAMES: Record<ChatAgent, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' };
type ChatPane = Pick<PaneInfo, 'agent' | 'display_agent' | 'agent_session'>;

export function chatAgentDisplayName(agent: ChatAgent): string {
  return CHAT_AGENT_NAMES[agent];
}

export function isClaudePane(pane: PaneInfo | undefined): boolean {
  return chatAgentForPane(pane) === 'claude';
}

export function isCodexPane(pane: PaneInfo | undefined): boolean {
  return chatAgentForPane(pane) === 'codex';
}

export function isOpenCodePane(pane: PaneInfo | undefined): boolean {
  return chatAgentForPane(pane) === 'opencode';
}

export function chatAgentForPane(pane: ChatPane | undefined): ChatAgent | null {
  const sessionAgent = pane?.agent_session?.agent.trim().toLowerCase();
  if (sessionAgent) {
    return Object.hasOwn(CHAT_AGENT_NAMES, sessionAgent)
      ? sessionAgent as ChatAgent
      : null;
  }
  const agent = pane?.agent?.trim() || pane?.display_agent?.trim() || '';
  if (/^claude(?:\s+code)?$/i.test(agent)) return 'claude';
  if (/^codex$/i.test(agent)) return 'codex';
  if (/^pi$/i.test(agent)) return 'pi';
  if (/^open\s*-?\s*code$/i.test(agent)) return 'opencode';
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
