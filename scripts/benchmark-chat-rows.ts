/* global globalThis */
// Desktop microbenchmark. This measures row work, not device frame time.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { Session, type HeapProfiler } from 'node:inspector';
import ts from 'typescript';

type ChatRow = { id: string; turnId: string; type: string; spacing: string; [key: string]: unknown };
type ChatRowUpdate = { baseRevision: number; revision: number; transcriptRevision: number; patches: unknown[] };
type TranscriptTurn = { id: string; status: 'idle'; diffs: { file: string; patch: string; additions: number; deletions: number }[];
  assistants: { id: string; role: 'assistant'; diffs: never[]; parts: { id: string; type: 'text'; text: string }[] }[] };

// Load the actual production patch applier and frozen old projection under
// Node, whose native type stripper doesn't resolve Metro's extensionless imports.
const require = createRequire(import.meta.url);
require.extensions['.ts'] = (module: NodeJS.Module, filename: string) => {
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  (module as NodeJS.Module & { _compile(code: string, filename: string): void })._compile(output.outputText, filename);
};
const { ChatRowStore } = require('../src/lib/nativeChatRows.ts') as { ChatRowStore: new () => { apply(update: ChatRowUpdate): boolean } };
const { transcriptBlocks } = require('../test-support/legacyChatBlocks.ts') as { transcriptBlocks: (turns: TranscriptTurn[], working: boolean, expanded: ReadonlySet<string>) => unknown[] };

function consume(value: unknown): void {
  (globalThis as typeof globalThis & { __whipChatRowBenchmarkResult?: unknown }).__whipChatRowBenchmarkResult = value;
}

function duration(operation: () => unknown, count: number): number {
  const start = performance.now();
  for (let index = 0; index < count; index++) consume(operation());
  return (performance.now() - start) / count;
}

function sampleBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + (node.children ?? []).reduce((sum, child) => sum + sampleBytes(child), 0);
}

async function allocations(operation: () => unknown, count: number): Promise<number> {
  globalThis.gc?.();
  const session = new Session(); session.connect();
  await new Promise<void>((resolve, reject) => session.post('HeapProfiler.startSampling', {
    samplingInterval: 4_096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
  }, error => { if (error) reject(error); else resolve(); }));
  for (let index = 0; index < count; index++) consume(operation());
  const profile = await new Promise<HeapProfiler.SamplingHeapProfile>((resolve, reject) => {
    session.post('HeapProfiler.stopSampling', (error, value) => { if (error) reject(error); else resolve(value.profile); });
  });
  session.disconnect();
  return sampleBytes(profile.head) / count;
}

interface NativeMeasurement { turns: number; rows: number; initialNs: number; streamNs: number; expandNs: number; collapseNs: number; [key: string]: number }
const reuse = process.argv.indexOf('--native-results');
let native: NativeMeasurement[];
if (reuse >= 0) {
  native = (JSON.parse(readFileSync(process.argv[reuse + 1], 'utf8')) as { results: NativeMeasurement[] }).results;
} else {
  const nativeLog = execFileSync('cargo', ['test', '--release', '--lib', '--manifest-path', 'packages/react-native-whip-ssh/rust/Cargo.toml',
    'chat_rows::benchmark::projection_benchmark', '--', '--ignored', '--nocapture', '--test-threads=1'], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const marker = nativeLog.split('\n').find(line => line.includes('CHAT_ROWS_BENCH='));
  if (!marker) throw new Error('Native benchmark produced no measurements');
  native = JSON.parse(marker.slice(marker.indexOf('CHAT_ROWS_BENCH=') + 'CHAT_ROWS_BENCH='.length)) as NativeMeasurement[];
}
const results = [];
for (const measured of native) {
  const turns: TranscriptTurn[] = Array.from({ length: measured.turns }, (_, index) => ({ id: `t${index}`, status: 'idle', diffs: [],
    assistants: [{ id: `m${index}`, role: 'assistant', diffs: [], parts: [{ id: 'text', type: 'text', text: 'Hello' }] }] }));
  const descriptors: ChatRow[] = turns.flatMap((turn, index) => [
    { id: JSON.stringify([turn.id, 'part', `m${index}`, 'text']), turnId: turn.id, type: 'part', messageId: `m${index}`,
      partId: 'text', partIndex: 0, partKind: 'text', first: true, streaming: index === turns.length - 1, spacing: index ? 'turn' : 'none' },
    { id: JSON.stringify([turn.id, 'meta']), turnId: turn.id, type: 'meta', spacing: 'none' },
  ]);
  const initial: ChatRowUpdate = { baseRevision: 0, revision: 1, transcriptRevision: 0, patches: [{ type: 'reset', rows: descriptors }] };
  const old = () => transcriptBlocks(turns, true, new Set());
  for (let index = 0; index < 50; index++) old();
  const oldInitialMs = duration(old, 30);
  const newInitialJsMs = duration(() => new ChatRowStore().apply(initial), 30);
  const store = new ChatRowStore(); store.apply(initial);
  (globalThis as typeof globalThis & { __whipChatRowBenchmarkStore?: unknown }).__whipChatRowBenchmarkStore = store;
  let transcriptRevision = 0;
  const patch = () => store.apply({ baseRevision: 1, revision: 1, transcriptRevision: ++transcriptRevision, patches: [] });
  // Warm the same production applier for every workload, including the first.
  for (let index = 0; index < 5_000; index++) patch();
  const oldStreamMs = duration(old, 500);
  const newStreamJsMs = duration(patch, 500);
  const oldSampledBytes = await allocations(old, 100);
  const newSampledBytes = await allocations(patch, 1_000);
  const section = JSON.stringify([turns.at(-1)!.id, 'changes']);
  turns.at(-1)!.diffs = Array.from({ length: 16 }, (_, index) => ({ file: `file${index}.rs`, patch: '+content', additions: 1, deletions: 0 }));
  const expanded = new Set([section]);
  const oldExpandMs = duration(() => transcriptBlocks(turns, true, expanded), 100);
  const oldCollapseMs = duration(old, 100);
  const diffRows: ChatRow[] = turns.at(-1)!.diffs.map((file, index) => ({
    id: JSON.stringify([turns.at(-1)!.id, 'diff', file.file, String(index)]), turnId: turns.at(-1)!.id, type: 'diff', diffIndex: index, spacing: 'part',
  }));
  const expandedRows: ChatRowUpdate = { baseRevision: 0, revision: 1, transcriptRevision: 0, patches: [{ type: 'reset', rows: [...descriptors.slice(0, -1),
    { id: section, turnId: turns.at(-1)!.id, type: 'changes', spacing: 'none' }, descriptors.at(-1)!] }] };
  const toggleStore = new ChatRowStore(); toggleStore.apply(expandedRows);
  let toggleRevision = 1;
  let newExpandJsMs = 0;
  let newCollapseJsMs = 0;
  for (let index = 0; index < 100; index++) {
    newExpandJsMs += duration(() => toggleStore.apply({ baseRevision: toggleRevision, revision: ++toggleRevision, transcriptRevision: 0,
      patches: [{ type: 'splice', index: descriptors.length, deleteCount: 0, rows: diffRows }] }), 1);
    newCollapseJsMs += duration(() => toggleStore.apply({ baseRevision: toggleRevision, revision: ++toggleRevision, transcriptRevision: 0,
      patches: [{ type: 'splice', index: descriptors.length, deleteCount: 16, rows: [] }] }), 1);
  }
  results.push({ ...measured, oldInitialMs, newInitialJsMs, oldStreamMs, newStreamJsMs, oldSampledBytes, newSampledBytes,
    oldExpandMs, oldCollapseMs, newExpandJsMs: newExpandJsMs / 100, newCollapseJsMs: newCollapseJsMs / 100 });
}
console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version,
  scope: 'Release Rust projection + Node production patch applier. JS allocation bytes are V8 samples. Excludes canonical transcript reconciliation, FFI encoding/scheduling/decoding, lazy row resolution, React rendering and device frame time. Wire bytes are actual UniFFI serialization; row protocol adds these bytes to existing transcript traffic.', results }, null, 2));
