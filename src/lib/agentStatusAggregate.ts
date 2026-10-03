import type { AgentStatus } from '../types';
import { agentStatusPriority } from './agentStatusPriority';

/** Presentation-only aggregation across already authoritative native projections. */
export function aggregateAgentStatus(
  statuses: readonly AgentStatus[],
  emptyStatus: AgentStatus,
): AgentStatus {
  return statuses.reduce<AgentStatus | undefined>((aggregate, status) => (
    aggregate === undefined || agentStatusPriority(status) < agentStatusPriority(aggregate)
      ? status
      : aggregate
  ), undefined) ?? emptyStatus;
}
