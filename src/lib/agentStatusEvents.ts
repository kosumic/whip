import type { AgentInfo, TabInfo } from '../types';

export function tabNameForAgent(
  agent: Pick<AgentInfo, 'tab_id'>,
  tabs: TabInfo[],
): string {
  const label = tabs.find(tab => tab.tab_id === agent.tab_id)?.label.trim();
  // Omit an unknown tab rather than exposing an internal identifier.
  return label || '';
}

export function agentNotificationTitle(
  agent: AgentInfo,
  tabName?: string,
  labels?: { needsAttention: (name: string) => string; finished: (name: string) => string },
  nameOverride?: string,
): string {
  // Herdr's reported agent label identifies the actual agent. Its managed
  // name may be derived from the tab label and is not a suitable display label.
  const name = nameOverride?.trim() || agent.agent?.trim() || agent.display_agent?.trim() || 'Agent';
  const action = agent.agent_status === 'blocked'
    ? labels?.needsAttention(name) || `${name} needs attention`
    : labels?.finished(name) || `${name} finished`;
  const label = tabName?.trim();
  return label && label !== name ? `${label} · ${action}` : action;
}
