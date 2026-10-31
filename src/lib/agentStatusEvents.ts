import type { AgentInfo, TabInfo } from '../types';

export function tabNameForAgent(
  agent: Pick<AgentInfo, 'tab_id'>,
  tabs: TabInfo[],
): string {
  const label = tabs.find(tab => tab.tab_id === agent.tab_id)?.label.trim();
  return label || agent.tab_id;
}

export function agentNotificationTitle(
  agent: AgentInfo,
  tabName?: string,
  labels?: { needsYou: (name: string) => string; finished: (name: string) => string },
): string {
  const name = agent.display_agent || agent.name || agent.agent || agent.pane_id;
  const action = agent.agent_status === 'blocked'
    ? labels?.needsYou(name) || `${name} needs you`
    : labels?.finished(name) || `${name} finished`;
  const label = tabName?.trim();
  return label ? `${label} · ${action}` : action;
}
