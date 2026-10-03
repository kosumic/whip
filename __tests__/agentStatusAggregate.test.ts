import { aggregateAgentStatus } from '../src/lib/agentStatusAggregate';
import type { AgentStatus } from '../src/types';

const STATUS_ORDER: readonly AgentStatus[] = ['blocked', 'done', 'working', 'idle', 'unknown'];

test.each(STATUS_ORDER)('aggregates %s ahead of lower priority statuses', status => {
  const statuses = STATUS_ORDER.slice(STATUS_ORDER.indexOf(status));
  expect(aggregateAgentStatus(statuses, 'unknown')).toBe(status);
  expect(aggregateAgentStatus([...statuses].reverse(), 'unknown')).toBe(status);
});

test.each(['unknown', 'idle'] as const)('uses the explicit %s default only for an empty set', emptyStatus => {
  expect(aggregateAgentStatus([], emptyStatus)).toBe(emptyStatus);
  expect(aggregateAgentStatus(['unknown'], emptyStatus)).toBe('unknown');
});
