// Run in the mini worktree. Ports are loopback-only and dedicated to this fixture.
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(process.argv[2]);
const appId = 'io.github.kaminarios.whip.skiasmoke';
const device = '35AF86B7-DC94-48B9-8215-82C9DE8E08F7';
const serverPid = Number(fs.readFileSync(path.join(root, 'herdr-process.pid')));
const sampler = path.join(root, 'resource-sampler');
const log = fs.createWriteStream(path.join(root, 'measurements.jsonl'), { flags: 'a' });
let received = 0, sent = 0, appPid = 0, simulatorPid = 0, current = null;
let nextRun = 0;
const modes = ['xterm.js', 'skia', 'skia', 'xterm.js', 'xterm.js', 'skia'];
const sockets = new Set();
function record(value) { log.write(JSON.stringify({ hostTimeMs: Date.now(), ...value }) + '\n'); }
function resolvePid() {
  const lines = execFileSync('/bin/ps', ['-axo', 'pid,ppid,args'], { encoding: 'utf8' }).split('\n');
  const row = lines.find(line => line.includes(`/Devices/${device}/`) && /WhipSkiaSmoke\.app\/HerdR\s*$/.test(line));
  if (row) [appPid, simulatorPid] = row.trim().split(/\s+/).map(Number);
}
function snapshot(kind) {
  try {
    resolvePid();
    const result = JSON.parse(execFileSync(sampler, [String(appPid), String(serverPid), String(simulatorPid)], { encoding: 'utf8' }));
    record({ kind, phase: current, received, sent, appPid, simulatorPid, ...result });
  } catch (error) { record({ kind: 'sampling-error', message: String(error) }); }
}
net.createServer(client => {
  const remote = net.connect(22391, '127.0.0.1');
  sockets.add(client); sockets.add(remote);
  client.on('data', buffer => { received += buffer.length; });
  remote.on('data', buffer => { sent += buffer.length; });
  client.pipe(remote).pipe(client);
  for (const socket of [client, remote]) {
    socket.on('error', () => { client.destroy(); remote.destroy(); });
    socket.on('close', () => sockets.delete(socket));
  }
}).listen(22392, '127.0.0.1');
http.createServer(async (request, response) => {
  const body = [];
  for await (const chunk of request) body.push(chunk);
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/event') {
    const event = JSON.parse(Buffer.concat(body).toString() || '{}');
    if (event.type === 'phase-start') { current = { run: event.run, mode: event.mode, name: event.name }; snapshot('phase-start'); }
    if (event.type === 'phase-end') { snapshot('phase-end'); current = null; }
    record({ kind: 'event', event });
    if (event.type === 'phase-end' && ['seq100000', 'unicode'].includes(event.name)) {
      execFileSync('/usr/bin/xcrun', ['simctl', 'io', device, 'screenshot', path.join(root, `${event.run}-${event.mode}-${event.name}.png`)], { stdio: 'ignore' });
    }
    if (event.type === 'complete') fs.writeFileSync(path.join(root, 'complete.json'), JSON.stringify(event));
    if (event.type === 'run-complete') fs.writeFileSync(path.join(root, `run-complete-${event.run}.json`), JSON.stringify(event));
    if (event.type === 'error') fs.writeFileSync(path.join(root, 'error.json'), JSON.stringify(event));
  } else if (url.pathname === '/disconnect') {
    for (const socket of sockets) socket.destroy();
    record({ kind: 'disconnect' });
  } else if (url.pathname === '/status') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ phase: current, appPid, received, sent })); return;
  } else if (url.pathname === '/run') {
    const run = nextRun++;
    resolvePid(); snapshot('run-start');
    record({ kind: 'run-start', run, mode: modes[run] });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ run, mode: modes[run] })); return;
  }
  response.end('ok');
}).listen(22393, '127.0.0.1', () => { record({ kind: 'controller-start', appId, device }); console.log('Benchmark controller ready'); });
setInterval(() => snapshot('sample'), 500).unref();
process.on('SIGTERM', () => { record({ kind: 'controller-stop' }); log.end(() => process.exit(0)); });
