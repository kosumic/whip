const fs = require('node:fs');
const events = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(line => JSON.parse(line));
const starts = new Map(), results = [], runs = new Map();
let lastRunSnapshot;
for (const event of events) {
  if (event.kind === 'run-start' && event.processes) lastRunSnapshot = event;
  else if (event.kind === 'run-start' && event.run !== undefined) runs.set(event.run, {
    mode: event.mode, baselineWebkit: new Set(lastRunSnapshot.processes.filter(p => p.kind === 'webkit').map(p => p.pid)),
  });
}
const quantile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
};
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
function counters(snapshot, role, run) {
  return snapshot.processes.filter(process => role === 'webkit' ? process.kind === 'webkit' && !run.baselineWebkit.has(process.pid) : process.kind === role);
}
function cpuDelta(first, last, role, run, threads = false) {
  const before = new Map();
  const add = (snapshot, callback) => {
    for (const process of counters(snapshot, role, run)) {
      if (!threads) callback(process.pid, process.cpuNs);
      else for (const thread of process.threads.filter(t => /^com\.facebook\.react.*JavaScript$/.test(t.name))) callback(`${process.pid}:${thread.id}`, thread.cpuNs);
    }
  };
  add(first, (key, value) => before.set(key, value));
  let delta = 0, matched = 0;
  add(last, (key, value) => { if (before.has(key)) { delta += value - before.get(key); matched++; } });
  return matched ? delta : null;
}
for (const event of events) {
  if (event.kind === 'phase-start') starts.set(`${event.phase.run}:${event.phase.name}`, event);
  if (event.kind !== 'event' || event.event.type !== 'phase-end') continue;
  const value = event.event, key = `${value.run}:${value.name}`;
  const first = starts.get(key);
  const last = events.slice(0, events.indexOf(event)).findLast(e => e.kind === 'phase-end' && `${e.phase.run}:${e.phase.name}` === key);
  if (!first || !last) throw Error('Missing counter boundary: ' + key);
  const run = runs.get(value.run), durationMs = last.hostTimeMs - first.hostTimeMs;
  const snapshots = events.filter(e => e.processes && e.hostTimeMs >= first.hostTimeMs && e.hostTimeMs <= last.hostTimeMs);
  const appNs = cpuDelta(first, last, 'app', run);
  if (appNs === null) throw Error('App counters missing: ' + key);
  if (value.mode === 'xterm.js' && cpuDelta(first, last, 'webkit', run) === null) throw Error('WebKit attribution missing: ' + key);
  if (!['resize-reattach', 'reconnect'].includes(value.name) && (value.geometry?.columns !== 80 || value.geometry?.rows !== 24)) throw Error('Grid mismatch: ' + key + ' ' + JSON.stringify(value.geometry));
  const webkitNs = cpuDelta(first, last, 'webkit', run) ?? 0;
  const serverNs = cpuDelta(first, last, 'herdr', run);
  const jsNs = cpuDelta(first, last, 'app', run, true);
  const footprints = snapshots.map(sample => [...counters(sample, 'app', run), ...counters(sample, 'webkit', run)].reduce((sum, p) => sum + p.footprint, 0));
  const prepared = value.samples.filter(s => s.phase === 'prepared');
  const proxy = value.samples.filter(s => s.phase === 'presented-proxy');
  if (!['idle', 'resize-reattach', 'reconnect'].includes(value.name) && !prepared.length) throw Error('No client frames: ' + key);
  if (value.name === 'typing' && value.inputProxyMs.length < 25) throw Error('Missing typing acknowledgements: ' + key);
  results.push({ run: value.run, renderer: value.mode, workload: value.name, durationMs,
    columns: value.geometry?.columns, rows: value.geometry?.rows,
    appCpuPercent: appNs / durationMs / 1e4,
    webkitCpuPercent: webkitNs / durationMs / 1e4,
    clientCpuPercent: (appNs + webkitNs) / durationMs / 1e4,
    rnJsCpuPercent: jsNs === null ? null : jsNs / durationMs / 1e4,
    herdrCpuPercent: serverNs / durationMs / 1e4,
    meanFootprintMiB: mean(footprints) / 1048576,
    peakFootprintMiB: Math.max(...footprints) / 1048576,
    sshReceivedBytes: last.received - first.received, sshSentBytes: last.sent - first.sent,
    sshDownloadBytesPerSecond: (last.sent - first.sent) / durationMs * 1000,
    sshUploadBytesPerSecond: (last.received - first.received) / durationMs * 1000,
    preparedPerSecond: prepared.length / durationMs * 1000,
    proxyCallbacksPerSecond: proxy.length / durationMs * 1000,
    prepareMsMedian: quantile(prepared.map(s => s.prepareMs).filter(Number.isFinite), 0.5),
    prepareMsP95: quantile(prepared.map(s => s.prepareMs).filter(Number.isFinite), 0.95),
    inputProxyMsMedian: quantile(value.inputProxyMs, 0.5), inputProxyMsP95: quantile(value.inputProxyMs, 0.95), inputSamples: value.inputProxyMs.length,
    bridgeCodeUnits: prepared.reduce((sum, sample) => sum + (sample.bridgeCodeUnits || 0), 0),
    paintedCells: prepared.some(s => Number.isFinite(s.paintedCells)) ? prepared.reduce((sum, s) => sum + (s.paintedCells || 0), 0) : null,
    shapedGlyphs: prepared.some(s => Number.isFinite(s.shapedGlyphs)) ? prepared.reduce((sum, s) => sum + (s.shapedGlyphs || 0), 0) : null,
    cacheHits: prepared.some(s => Number.isFinite(s.cacheHits)) ? prepared.reduce((sum, s) => sum + (s.cacheHits || 0), 0) : null,
    paintedCellsMedian: quantile(prepared.map(s => s.paintedCells).filter(Number.isFinite), 0.5),
    appPids: counters(last, 'app', run).map(p => p.pid),
    webkitProcesses: counters(last, 'webkit', run).map(p => ({ pid: p.pid, name: p.name })),
    jsThreadNames: counters(last, 'app', run).flatMap(p => p.threads.filter(t => /^com\.facebook\.react.*JavaScript$/.test(t.name)).map(t => t.name)),
  });
}
const aggregate = [];
for (const workload of [...new Set(results.map(r => r.workload))]) for (const renderer of ['xterm.js', 'skia']) {
  const trials = results.filter(r => r.workload === workload && r.renderer === renderer);
  const item = { renderer, workload, trials: trials.length };
  for (const metric of ['clientCpuPercent','appCpuPercent','webkitCpuPercent','rnJsCpuPercent','herdrCpuPercent','meanFootprintMiB','peakFootprintMiB','sshReceivedBytes','sshSentBytes','sshDownloadBytesPerSecond','sshUploadBytesPerSecond','preparedPerSecond','proxyCallbacksPerSecond','prepareMsMedian','prepareMsP95','inputProxyMsMedian','inputProxyMsP95','bridgeCodeUnits','paintedCells','shapedGlyphs','cacheHits','paintedCellsMedian']) {
    item[metric] = quantile(trials.map(trial => trial[metric]).filter(v => v !== null && Number.isFinite(v)), 0.5);
  }
  aggregate.push(item);
}
const attach = ['xterm.js','skia'].map(renderer => {
  const metric = type => events.filter(e => e.kind === 'event' && e.event.type === type && e.event.mode === renderer && e.event.run >= 0).map(e => e.event.ms);
  return { renderer, firstPreparedMs: metric('first-prepared'), firstPresentedProxyMs: metric('first-presented-proxy') };
});
const output = { caveat: 'iOS Simulator, Release, opt-in per-frame observations. CPU is percent of one core. WebKit attribution uses new child processes of the benchmark simulator after each fresh-process run begins. Timing and update rates are preparation/two-rAF proxies, not compositor FPS or visible latency.', attach, aggregate, trials: results };
process.stdout.write(JSON.stringify(output, null, 2) + '\n');
