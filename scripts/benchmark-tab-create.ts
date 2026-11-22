import { readFileSync } from 'node:fs';

type Sample = { phase: string; backend: string; runtime: string; durationMs: number };

export function summarizeTabCreateLog(log: string) {
  const samples: Sample[] = [];
  for (const line of log.split('\n')) {
    const marker = line.indexOf('tab-benchmark ');
    if (marker < 0) continue;
    const fields = Object.fromEntries(line.slice(marker + 'tab-benchmark '.length).split(/\s+/).map(field => {
      const separator = field.indexOf('=');
      return [field.slice(0, separator), field.slice(separator + 1)];
    }));
    const durationMs = Number(fields.duration_ms);
    if (!fields.phase || !fields.backend || !fields.runtime || !Number.isFinite(durationMs)) continue;
    samples.push({ phase: fields.phase, backend: fields.backend, runtime: fields.runtime, durationMs });
  }
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const key = `${sample.runtime}/${sample.backend}/${sample.phase}`;
    const group = groups.get(key) || [];
    group.push(sample);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([group, values]) => {
    const durations = values.map(value => value.durationMs).sort((a, b) => a - b);
    const percentile = (fraction: number) => durations[Math.max(0, Math.ceil(durations.length * fraction) - 1)];
    return { group, count: durations.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), totalMs: durations.reduce((sum, value) => sum + value, 0) };
  });
}

if (process.argv[1]?.endsWith('/benchmark-tab-create.ts')) {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: node scripts/benchmark-tab-create.ts RUNTIME_LOG');
  console.log(JSON.stringify(summarizeTabCreateLog(readFileSync(path, 'utf8')), null, 2));
}
