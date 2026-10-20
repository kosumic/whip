/* global globalThis */
/* eslint-disable no-bitwise -- XOR keeps the benchmark checksum inexpensive. */
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { arrayBufferToBase64 } from '../src/lib/base64.ts';

const traceIndex = process.argv.indexOf('--trace');
const workloadIndex = process.argv.indexOf('--workload');
const failWorkload = (error: unknown) => { console.error(error); process.exitCode = 1; };
async function graphicsWorkload(): Promise<void> {
  const size = 256;
  const pixels = Buffer.alloc(size * size * 4);
  const palette = [[40, 210, 150, 255], [80, 70, 220, 255]];
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const offset = (y * size + x) * 4;
    const color = (Math.floor(x / 32) + Math.floor(y / 32)) % palette.length;
    pixels.set(palette[color], offset);
  }
  const { default: sharp } = await import('sharp');
  const encoded = (await sharp(pixels, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer()).toString('base64');
  const chunkSize = 4096;
  process.stdout.write('\x1b[2J\x1b[HKitty bridge smoke\r\n');
  for (let offset = 0; offset < encoded.length; offset += chunkSize) {
    const metadata = offset === 0 ? 'a=T,t=d,f=100,i=424242,q=2,' : '';
    const more = offset + chunkSize < encoded.length ? 1 : 0;
    process.stdout.write(`\x1b_G${metadata}m=${more};${encoded.slice(offset, offset + chunkSize)}\x1b\\`);
  }
  process.stdout.write('\x1b[12;1Hafter graphics: π 🙂 漢字\x07\r\n');
  // Leave the fixture visible before shell prompt hooks print or resize it.
  await delay(10_000);
}
if (workloadIndex >= 0) {
  const mode = process.argv[workloadIndex + 1];
  if (mode === 'graphics') void graphicsWorkload().catch(failWorkload);
  else {
  if (mode !== 'small' && mode !== 'continuous') throw new Error('Use --workload small|continuous|graphics in a disposable terminal.');
  const frames = 600;
  const bytes = mode === 'small' ? 32 : 64 * 1024;
  const payloads = ['a', 'b'].map(character => Buffer.from(
    `${character.repeat(78)}\r\n`.repeat(Math.ceil(bytes / 80)).slice(0, bytes),
  ));
  const run = async () => {
    const started = performance.now();
    for (let frame = 0; frame < frames; frame += 1) {
      const payload = payloads[frame % payloads.length];
      payload.write(String(frame).padStart(8, '0'), 0, 'ascii');
      if (!process.stdout.write(payload)) await once(process.stdout, 'drain');
      await delay(16);
    }
    process.stdout.write(`\r\nbridge workload complete: ${frames} frames, ${frames * bytes} bytes, ${(performance.now() - started).toFixed(0)} ms\r\n`);
  };
  void run().catch(failWorkload);
  }
} else if (traceIndex >= 0) {
  const processorIndex = process.argv.indexOf('--trace-processor');
  const processor = processorIndex >= 0 ? process.argv[processorIndex + 1] : process.env.TRACE_PROCESSOR;
  const trace = process.argv[traceIndex + 1];
  if (!processor || !trace) throw new Error('Use --trace FILE --trace-processor PATH (or TRACE_PROCESSOR).');
  const webviewIndex = process.argv.indexOf('--webview-pid');
  const webviewPid = webviewIndex >= 0 ? Number(process.argv[webviewIndex + 1]) : null;
  if (webviewPid !== null && (!Number.isSafeInteger(webviewPid) || webviewPid <= 0)) throw new Error('--webview-pid requires a verified positive process ID.');
  let sql = readFileSync(resolve('scripts/analyze-terminal-delivery.sql'), 'utf8');
  if (webviewPid !== null) sql += `
SELECT ROUND(SUM(s.dur) / 1e6, 3) AS app_and_webview_cpu_ms,
  ROUND(100.0 * SUM(s.dur) / (SELECT end_ts - start_ts FROM trace_bounds), 2) AS app_and_webview_cpu_percent
FROM sched s JOIN thread th USING (utid) JOIN process p USING (upid)
WHERE (p.name = 'io.github.kaminarios.whip' OR p.pid = ${webviewPid}) AND s.dur > 0;
SELECT t.name, ROUND(MAX(c.value) / 1048576.0, 2) AS webview_peak_mib,
  ROUND(AVG(CASE WHEN c.ts > (SELECT start_ts + (end_ts - start_ts) * 2 / 3 FROM trace_bounds)
    THEN c.value END) / 1048576.0, 2) AS webview_final_third_mean_mib
FROM counter c JOIN process_counter_track t ON c.track_id = t.id JOIN process p USING (upid)
WHERE p.pid = ${webviewPid} AND t.name IN ('mem.rss', 'mem.rss.anon', 'mem.swap') GROUP BY t.name;
`;
  console.log(`Device trace results. Visible means the two-rAF proxy. CPU covers the app${webviewPid === null ? ' process' : ` and verified WebView renderer ${webviewPid}`}.`);
  process.stdout.write(execFileSync(processor, ['query', '-f', '-', trace], { input: sql }));
} else {

const TARGET_BYTES = 256 * 1024 * 1024;
const RAW_CHUNK_BYTES = 48 * 1024;

// Boundary-only diagnostics. Payload encoding/serialization on Rust, UniFFI,
// Hermes scheduling, platform WebView IPC, xterm, and painting are excluded.
// Use --trace for device measurements; these numbers cannot establish a
// terminal latency, CPU, allocation, or throughput improvement.

function terminalPayload(payloadBytes: number) {
  const payload = new Uint8Array(payloadBytes);
  for (let index = 0; index < payload.byteLength; index += 1) {
    payload[index] = index % 251;
  }
  return payload;
}

function scriptBytes(value: string | string[]): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  return value.reduce((total, script) => total + Buffer.byteLength(script, 'utf8'), 0);
}

function measure(payloadBytes: number, iterations: number, operation: () => string | string[]) {
  let checksum = 0;
  for (let index = 0; index < Math.min(iterations, 2000); index += 1) {
    const value = operation();
    checksum ^= scriptBytes(value);
  }
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const value = operation();
    checksum ^= scriptBytes(value);
  }
  const elapsedMs = performance.now() - started;
  const mibPerSecond = (payloadBytes * iterations) / (1024 * 1024) / (elapsedMs / 1000);
  return { elapsedMs, mibPerSecond, checksum };
}

console.log('Terminal bridge JS-boundary diagnostics (not a device performance comparison)');
console.log('Node', process.version);
console.log('Includes Node UTF-8 byte measurement to consume each script; not Hermes/WebView string transfer.');
console.log('bytes\titerations\tbinary JS base64+script ms\tHerdr script ms\tbatch envelopes ms');

for (const payloadBytes of [32, 4 * 1024, 64 * 1024, 1024 * 1024]) {
  const payload = terminalPayload(payloadBytes);
  const iterations = Math.min(10_000, Math.max(32, Math.floor(TARGET_BYTES / payloadBytes)));
  const encoded = Buffer.from(payload).toString('base64');
  if (arrayBufferToBase64(payload) !== encoded) throw new Error('Base64 paths disagree');
  const packets: string[] = [];
  for (let offset = 0; offset < payload.length; offset += RAW_CHUNK_BYTES) {
    packets.push(JSON.stringify(['host:pane', 'renderer', '1', String(offset), [{ kind: 'bytes', data: Buffer.from(payload.subarray(offset, offset + RAW_CHUNK_BYTES)).toString('base64') }]]));
  }
  const ssh = measure(payloadBytes, iterations, () => `window.herdrWriteBase64Chunk("host:pane", 1, ${JSON.stringify(arrayBufferToBase64(payload))}, true, null, null, null);`);
  const herdr = measure(payloadBytes, iterations, () => `window.herdrWriteBase64Chunk("host:pane", 1, ${JSON.stringify(encoded)}, true, null, null, null);`);
  const batched = measure(payloadBytes, iterations, () => packets.map(json => `window.herdrDeliverBatch(${json}, false, null, null, null);`));
  console.log(
    `${payloadBytes}\t${iterations}\t${ssh.elapsedMs.toFixed(2)}\t${herdr.elapsedMs.toFixed(2)}\t${batched.elapsedMs.toFixed(2)}`
  );
}
}
