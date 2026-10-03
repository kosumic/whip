import type { AgentStatus } from '../types';

const AGENT_STATUS_PRIORITY: Readonly<Record<AgentStatus, number>> = {
  blocked: 0,
  done: 1,
  working: 2,
  idle: 3,
  unknown: 4,
};

/** Lower values come first in both sorting and aggregation. */
export function agentStatusPriority(status: AgentStatus): number {
  return AGENT_STATUS_PRIORITY[status];
}
