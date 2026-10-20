import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: options } = parseArgs({ options: {
  trace: { type: 'string' }, processor: { type: 'string' }, output: { type: 'string' },
} });
if (!options.trace || !options.processor) throw new Error('Usage: --trace FILE --processor TRACE_PROCESSOR_SHELL [--output FILE]');
const trace = options.trace;
const processor = options.processor;
function query(sql: string): string[][] {
  const result = execFileSync(processor, ['-Q', sql, trace], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  // These queries return numeric fields and names with no commas.
  return result.trim().split('\n').slice(1).filter(Boolean).map(line => line.split(','));
}
function statistics(samples: number[]) {
  if (!samples.length) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: sorted.length, min: sorted[0], p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
    p95: sorted[Math.ceil((sorted.length - 1) * 0.95)], max: sorted.at(-1), mean: samples.reduce((sum, value) => sum + value, 0) / samples.length };
}
const counters = new Map<string, number[]>();
for (const [name, , value] of query(`SELECT t.name,c.ts,c.value FROM counter c
  JOIN process_counter_track t ON t.id=c.track_id JOIN process p USING(upid)
  WHERE p.name='io.github.kaminarios.whip' AND t.name GLOB 'Whip chat*' ORDER BY c.ts`)) {
  const key = JSON.parse(name) as string;
  const samples = counters.get(key) ?? [];
  samples.push(Number(value)); counters.set(key, samples);
}
const metrics = Object.fromEntries([...counters].map(([name, samples]) => [name, statistics(samples)]));
const combined: Record<string, ReturnType<typeof statistics>> = {};
for (const phase of ['initial', 'stream']) {
  const names = ['roundtrip', 'descriptor mapping', 'patch application'];
  const samples = names.map(name => counters.get(`Whip chat ${phase} ${name} us`) ?? []);
  if (samples[0].length && samples.every(values => values.length === samples[0].length)) {
    combined[`${phase} total row work us`] = statistics(samples[0].map((_, index) => samples.reduce((sum, values) => sum + values[index], 0)));
  }
}
const frames = query(`SELECT COUNT(*),SUM(CASE WHEN jank_type GLOB '*App Deadline Missed*' THEN 1 ELSE 0 END),
  SUM(CASE WHEN jank_type GLOB '*Dropped Frame*' THEN 1 ELSE 0 END),AVG(dur)/1e6,MAX(dur)/1e6
  FROM actual_frame_timeline_slice JOIN process USING(upid) WHERE process.name='io.github.kaminarios.whip'`)[0]?.map(Number);
const threads = query(`SELECT t.name,SUM(s.dur)/1e6 FROM sched s JOIN thread t USING(utid) JOIN process p USING(upid)
  WHERE p.name='io.github.kaminarios.whip' GROUP BY t.utid ORDER BY SUM(s.dur) DESC LIMIT 12`)
  .map(([name, value]) => ({ name: JSON.parse(name) as string, cpuMs: Number(value) }));
const errors = query("SELECT name,SUM(value) FROM stats WHERE severity='error' AND value>0 GROUP BY name")
  .map(([name, value]) => ({ name: JSON.parse(name) as string, count: Number(value) }));
const output = JSON.stringify({ trace, units: 'Timing counters and combined row work are microseconds. CPU and frames are milliseconds.',
  scope: 'Cached native polling includes request lowering, native scheduling/projection, UniFFI serialization/lifting, and JS continuation. Combined adds descriptor conversion and production patch application. Legacy is the frozen previous projection on the same conversation. Rendering is measured separately; this is not a full old/new UI A/B.',
  benchmarkPhases: counters.get('Whip chat benchmark phase') ?? [], metrics, combined,
  frames: frames ? { count: frames[0], appDeadlineMisses: frames[1], dropped: frames[2], meanMs: frames[3], maxMs: frames[4] } : undefined,
  threads, traceErrors: errors }, null, 2) + '\n';
if (options.output) writeFileSync(options.output, output);
else process.stdout.write(output);
