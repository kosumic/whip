import type { AgentStatus, HerdrSnapshot } from '../types';
import { aggregateAgentStatus } from './agentStatusAggregate';

export interface HostRuntimeSummary {
  agentStatus: AgentStatus;
  agentTotal: number;
  protocol: number | null;
}

export function hostRuntimeSummary(snapshot: HerdrSnapshot): HostRuntimeSummary {
  return {
    agentStatus: aggregateAgentStatus(snapshot.agents.map(agent => agent.agent_status), 'unknown'),
    agentTotal: snapshot.agents.length,
    protocol: Number.isFinite(snapshot.server.protocol) ? snapshot.server.protocol! : null,
  };
}
