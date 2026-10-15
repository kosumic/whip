import { readFile } from 'node:fs/promises';

const inputPath = process.argv[2];
const resizePath = process.argv[3];
const resizeEventsPath = process.argv[4];
if (!inputPath) {
  console.error('usage: node scripts/render-android-terminal-latency.ts <input.csv> [resize.csv] [resize-events.csv]');
  process.exit(2);
}

function parseCsvLine(line: string) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      values.push(current);
      current = '';
    } else current += character;
  }
  values.push(current);
  return values;
}

async function readCsv(path: string | undefined): Promise<Record<string, string>[]> {
  if (!path) return [];
  const lines = (await readFile(path, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => Object.fromEntries(
    parseCsvLine(line).map((value, index) => [headers[index], value]),
  ));
}

const rows = await readCsv(inputPath);
if (rows.length === 0) throw new Error('Perfetto analysis returned no input samples');
const number = (value: string | undefined) => {
  const parsed = value === '' || value == null ? 0 : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const maxStage = Math.max(1, ...rows.flatMap(row => [
  number(row.local_dispatch_ms),
  number(row.queue_to_response_ms),
  number(row.frame_to_visible_ms),
]));
const bar = (value: number) => {
  const count = value > 0 ? Math.max(1, Math.round((value / maxStage) * 30)) : 0;
  return `${'█'.repeat(count)}${'░'.repeat(30 - count)}`;
};

console.log('# Android terminal input latency');
console.log('');
console.log('| Phase | Samples | Local dispatch | Queue → response | Frame → visible | Total | Min–max |');
console.log('|---|---:|---:|---:|---:|---:|---:|');
for (const row of rows) {
  console.log(`| ${row.phase} | ${row.samples} | ${number(row.local_dispatch_ms).toFixed(2)} ms | ${number(row.queue_to_response_ms).toFixed(2)} ms | ${number(row.frame_to_visible_ms).toFixed(2)} ms | **${number(row.input_to_visible_ms).toFixed(2)} ms** | ${number(row.min_ms).toFixed(2)}–${number(row.max_ms).toFixed(2)} ms |`);
}
console.log('');
for (const row of rows) {
  console.log(`## ${row.phase}`);
  console.log('');
  for (const [label, key] of [
    ['local dispatch', 'local_dispatch_ms'],
    ['queue → response', 'queue_to_response_ms'],
    ['frame → visible', 'frame_to_visible_ms'],
  ]) {
    const value = number(row[key]);
    console.log(`\`${bar(value)}\` ${label}: ${value.toFixed(2)} ms`);
  }
  console.log('');
}
const cold = rows[0];
console.log('## Cold readiness observed');
console.log('');
console.log(`- input waits for writable: ${cold.cold_wait_samples} sample(s), ${number(cold.cold_wait_ms).toFixed(2)} ms average`);
console.log(`- renderer readiness: ${number(cold.renderer_readiness_ms).toFixed(2)} ms`);
console.log(`- bridge attach: ${number(cold.bridge_attach_ms).toFixed(2)} ms`);
console.log('');
console.log('The queue-to-response span intentionally combines native queueing, SSH/network RTT, remote PTY processing, and inbound Herdr decoding. No terminal contents are included.');

const resizeRows = await readCsv(resizePath);
if (resizeRows.length > 0) {
  console.log('');
  console.log('# Android terminal resize latency');
  console.log('');
  console.log('| Burst | Requests | Fit / xterm | Superseded / deduplicated | Wait writable | Native dispatch | To first frame | Frame → visible | Total visible | Timeouts |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of resizeRows) {
    console.log(`| ${row.phase} | ${row.requests} | ${row.fit_requests} / ${row.xterm_requests} | ${row.superseded} / ${row.deduplicated} | ${number(row.wait_for_writable_ms).toFixed(2)} ms | ${number(row.native_dispatch_ms).toFixed(2)} ms | ${number(row.to_first_frame_ms).toFixed(2)} ms | ${number(row.frame_to_visible_ms).toFixed(2)} ms | **${number(row.resize_to_visible_ms).toFixed(2)} ms** | ${row.timeouts} |`);
  }
  console.log('');
  console.log('Bursts are separated by 750 ms of resize inactivity. With the workflow’s fixed scenario, burst 1 is the cold selection/rotation and burst 2 is the warm return/rotation.');
}

const resizeEvents = await readCsv(resizeEventsPath);
if (resizeEvents.length > 0) {
  console.log('');
  console.log('## Resize request sequence');
  console.log('');
  console.log('Each entry contains only sequence, source, dimensions, cell size, and scheduling/fit timing:');
  console.log('');
  for (const row of resizeEvents) console.log(`- +${number(row.offset_ms).toFixed(2)} ms — ${row.resize_event}`);
}
