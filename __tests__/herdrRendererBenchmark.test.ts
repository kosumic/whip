import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { hasCompletionMarker } = require('../scripts/herdr-renderer-benchmark/completion.cjs');

it('requires a standalone completion line instead of matching an echoed command', () => {
  expect(hasCompletionMarker("$ xxxxxseq 1 100000 && printf 'SEQ_DONE\\n'\ncommand not found\n$ ", 'SEQ_DONE')).toBe(false);
  expect(hasCompletionMarker('$ seq 1 100000\n99999\n100000\nSEQ_DONE\n$ ', 'SEQ_DONE')).toBe(true);
});

const mib = 1048576;
function fixture(columns = 80) {
  const process = (pid: number, kind: string, cpuNs: number, footprint: number) => ({
    pid, kind, name: kind, cpuNs, footprint, threads: kind === 'app'
      ? [{ id: 1, name: 'com.facebook.react.runtime.JavaScript', cpuNs: cpuNs / 5 }]
      : [],
  });
  const state = (appCpu: number, webCpu: number, serverCpu: number) => [
    process(1, 'app', appCpu, 100 * mib),
    process(2, 'herdr', serverCpu, 10 * mib),
    process(3, 'webkit', webCpu, 200 * mib),
    process(9, 'webkit', webCpu * 100, 900 * mib), // unrelated pre-existing process
  ];
  const phase = { run: 0, mode: 'xterm.js', name: 'idle' };
  return [
    { kind: 'run-start', hostTimeMs: 0, processes: [process(9, 'webkit', 0, 900 * mib)] },
    { kind: 'run-start', hostTimeMs: 1, run: 0, mode: 'xterm.js' },
    { kind: 'phase-start', hostTimeMs: 1000, phase, received: 10, sent: 100, processes: state(1e9, 2e9, 3e9) },
    { kind: 'phase-end', hostTimeMs: 2000, phase, received: 110, sent: 1100, processes: state(1.25e9, 2.5e9, 3.1e9) },
    { kind: 'event', hostTimeMs: 2001, event: { type: 'phase-end', ...phase, geometry: { columns, rows: 24 }, samples: [], inputProxyMs: [] } },
  ];
}
function analyze(events: unknown[]) {
  const directory = mkdtempSync(join(tmpdir(), 'whip-benchmark-'));
  try {
    const path = join(directory, 'events.jsonl');
    writeFileSync(path, events.map(value => JSON.stringify(value)).join('\n'));
    return JSON.parse(execFileSync(process.execPath, [resolve('scripts/herdr-renderer-benchmark/analyze.cjs'), path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
it('accounts for app and new WebKit CPU and memory while excluding pre-existing processes', () => {
  const result = analyze(fixture()).trials[0];
  expect(result.appCpuPercent).toBe(25);
  expect(result.webkitCpuPercent).toBe(50);
  expect(result.clientCpuPercent).toBe(75);
  expect(result.rnJsCpuPercent).toBe(5);
  expect(result.herdrCpuPercent).toBe(10);
  expect(result.meanFootprintMiB).toBe(300);
  expect(result.sshReceivedBytes).toBe(100);
  expect(result.sshSentBytes).toBe(1000);
  expect(result.sshDownloadBytesPerSecond).toBe(1000);
  expect(result.sshUploadBytesPerSecond).toBe(100);
});
it('refuses a comparison with different terminal grid dimensions', () => {
  expect(() => analyze(fixture(79))).toThrow();
});
it('aggregates painted cells and shaping work separately from presentation counts', () => {
  const events = fixture();
  const end = events.at(-1)! as unknown as { event: { samples: unknown[] } };
  end.event.samples = [
    { phase: 'prepared', paintedCells: 3, shapedGlyphs: 1, cacheHits: 2 },
    { phase: 'presented-proxy' },
    { phase: 'prepared', paintedCells: 4, shapedGlyphs: 0, cacheHits: 4 },
  ];
  const result = analyze(events).trials[0];
  expect(result.paintedCells).toBe(7);
  expect(result.shapedGlyphs).toBe(1);
  expect(result.cacheHits).toBe(6);
  expect(result.paintedCellsMedian).toBe(3);
});
