import type { AgentInfo, AgentStatus, TabInfo, WorkspaceInfo } from './types';

export interface HerdHostQueue {
  id: string;
  label: string;
  address: string;
  running: boolean;
  refreshing: boolean;
  agents: AgentInfo[];
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
}

export interface HerdQueueAgent {
  hostId: string;
  hostLabel: string;
  agent: AgentInfo;
  tabLabel: string;
  primaryLabel: string;
}

export interface HerdProjectionRequest {
  hostId: string | null;
  workspaceId: string | null;
}

/**
 * Resolves enough navigation intent to address a host-scoped workspace filter.
 * Rust still validates these requests and owns the effective Herd projection.
 */
export function resolveHerdProjectionRequest(
  sessionIds: readonly string[],
  requestedHostId: string | null,
  workspaceFilterIds: Readonly<Record<string, string | null>>,
): HerdProjectionRequest {
  const validRequestedHostId = requestedHostId && sessionIds.includes(requestedHostId)
    ? requestedHostId
    : null;
  const effectiveHostId = validRequestedHostId
    ?? (sessionIds.length === 1 ? sessionIds[0] : null);

  return {
    hostId: effectiveHostId,
    workspaceId: effectiveHostId
      ? workspaceFilterIds[effectiveHostId] ?? null
      : null,
  };
}

const AGENT_STATUS_SORT_PRIORITY: Record<AgentStatus, number> = {
  blocked: 0,
  done: 1,
  working: 2,
  idle: 3,
  unknown: 4,
};

export function compareAgentStatusPriority(a: AgentStatus, b: AgentStatus): number {
  return AGENT_STATUS_SORT_PRIORITY[a] - AGENT_STATUS_SORT_PRIORITY[b];
}

export function orderByConnectionAndAgentStatusPriority<T>(
  items: readonly T[],
  connectedOf: (item: T) => boolean,
  statusOf: (item: T) => AgentStatus,
): T[] {
  return [...items].sort((a, b) => {
    const aConnected = connectedOf(a);
    const bConnected = connectedOf(b);
    if (aConnected !== bConnected) return aConnected ? -1 : 1;
    return aConnected ? compareAgentStatusPriority(statusOf(a), statusOf(b)) : 0;
  });
}

export function orderByAgentStatusPriority<T>(
  items: readonly T[],
  statusOf: (item: T) => AgentStatus,
  stateChangeSequenceOf?: (item: T) => number | undefined,
): T[] {
  return [...items].sort((a, b) => {
    const statusPriority = compareAgentStatusPriority(statusOf(a), statusOf(b));
    if (statusPriority !== 0 || !stateChangeSequenceOf) return statusPriority;

    const aSequence = stateChangeSequenceOf(a);
    const bSequence = stateChangeSequenceOf(b);
    if (aSequence === bSequence) return 0;
    if (aSequence === undefined) return 1;
    if (bSequence === undefined) return -1;
    return aSequence > bSequence ? -1 : 1;
  });
}

export function tabAgentStateChangeSequence(
  tab: Pick<TabInfo, 'tab_id' | 'agent_status'>,
  agents: readonly AgentInfo[],
): number | undefined {
  let latest: number | undefined;
  for (const agent of agents) {
    if (
      agent.tab_id !== tab.tab_id
      || agent.agent_status !== tab.agent_status
      || agent.state_change_seq === undefined
    ) {
      continue;
    }
    latest = latest === undefined
      ? agent.state_change_seq
      : Math.max(latest, agent.state_change_seq);
  }
  return latest;
}
