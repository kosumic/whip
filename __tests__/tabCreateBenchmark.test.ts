import { summarizeTabCreateLog } from '../scripts/benchmark-tab-create';

test('tab benchmark counts recovery snapshots separately from RPC and model projection latency', () => {
  const result = summarizeTabCreateLog([
    'unrelated log line',
    '123 tab-benchmark phase=rpc runtime=host-a backend=legacy duration_ms=90',
    '124 tab-benchmark phase=rpc runtime=host-a backend=legacy duration_ms=110',
    '125 tab-benchmark phase=projection runtime=host-a backend=legacy duration_ms=0.2 outcome=NeedsResync("missing layout")',
    '126 tab-benchmark phase=subscription runtime=host-a backend=legacy duration_ms=70 panes=4 success=true',
    '127 tab-benchmark phase=snapshot runtime=host-a backend=legacy duration_ms=80 outcome=Applied',
    '128 tab-benchmark phase=projection runtime=host-b backend=core duration_ms=0.3 success=true',
    '129 tab-benchmark phase=rpc runtime=host-b backend=core duration_ms=invalid',
  ].join('\n'));
  expect(result.find(value => value.group === 'host-a/legacy/rpc')).toEqual({ group: 'host-a/legacy/rpc', count: 2, p50Ms: 90, p95Ms: 110, totalMs: 200 });
  expect(result.find(value => value.group === 'host-a/legacy/snapshot')?.count).toBe(1);
  expect(result.filter(value => value.group.startsWith('host-b'))).toEqual([{ group: 'host-b/core/projection', count: 1, p50Ms: 0.3, p95Ms: 0.3, totalMs: 0.3 }]);
});
