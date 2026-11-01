#!/usr/bin/env node
// Run native Rust transport checks inside an already booted arm64 simulator.
const {execFileSync, spawn} = require('node:child_process');
const {mkdirSync} = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const crate = path.resolve(__dirname, '..');
const device = process.env.WHIP_IOS_SIMULATOR;
if (process.platform !== 'darwin' || !device) {
  throw new Error('Set WHIP_IOS_SIMULATOR to a booted iPhone simulator UDID on macOS.');
}
mkdirSync(path.join(crate, 'target'), {recursive: true});
const reference = path.join(crate, 'target/tailcat-reference');
execFileSync(process.env.GO || 'go', ['test', '-mod=readonly', '-c', '-o', reference], {
  cwd: path.join(__dirname, 'reference'), stdio: 'inherit',
  env: {...process.env, CGO_ENABLED: '0'},
});

const target = 'aarch64-apple-ios-sim';
const buildEnvironment = {
  ...process.env,
  PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH}`,
  DEVELOPER_DIR: process.env.WHIP_DEVELOPER_DIR || '/Applications/Xcode.app/Contents/Developer',
  IPHONEOS_DEPLOYMENT_TARGET: process.env.IPHONEOS_DEPLOYMENT_TARGET || '16.4',
};
for (const name of Object.keys(buildEnvironment)) {
  if (name.startsWith('NIX_')) delete buildEnvironment[name];
}
buildEnvironment.SDKROOT = execFileSync('/usr/bin/xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], {
  env: buildEnvironment, encoding: 'utf8',
}).trim();
buildEnvironment.CC_aarch64_apple_ios_sim = '/usr/bin/clang';
buildEnvironment.CARGO_TARGET_AARCH64_APPLE_IOS_SIM_LINKER = '/usr/bin/clang';
const compileArguments = ['test', '--locked', '--manifest-path', path.join(crate, 'Cargo.toml'),
  '--target', target, '--test', 'ios_simulator', '--no-run', '--message-format=json'];
let messages;
try {
  messages = execFileSync('cargo', compileArguments, {
    cwd: crate, env: buildEnvironment, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 10 << 20,
  });
} catch (error) {
  for (const line of (error.stdout || '').trim().split('\n')) {
    try {
      const message = JSON.parse(line);
      if (message.reason === 'compiler-message' && message.message.rendered) process.stderr.write(message.message.rendered);
    } catch { /* Cargo may also emit non-JSON build diagnostics. */ }
  }
  throw new Error(`Simulator test compilation failed with status ${error.status}.`);
}
const executable = messages.trim().split('\n').map(line => JSON.parse(line)).findLast(
  message => message.reason === 'compiler-artifact' && message.target.name === 'ios_simulator' && message.executable,
)?.executable;
if (!executable) throw new Error('Cargo did not report the simulator test executable.');

async function main() {
  const fixture = spawn(reference, ['-test.run=^TestWhipTailcatReference$'], {stdio: ['pipe', 'pipe', 'inherit']});
  const lines = readline.createInterface({input: fixture.stdout});
  const startup = setTimeout(() => fixture.kill(), 10_000);
  try {
    let address;
    for await (const line of lines) {
      try { address = JSON.parse(line).address; } catch { continue; }
      if (address) break;
    }
    clearTimeout(startup);
    if (!address) throw new Error('The upstream test server did not become ready.');
    execFileSync('xcrun', ['simctl', 'spawn', device, executable, '--ignored', '--nocapture'], {
      env: {...buildEnvironment, SIMCTL_CHILD_WHIP_TAILCAT_TEST_ADDRESS: address},
      stdio: 'inherit', timeout: 90_000,
    });
  } finally {
    clearTimeout(startup);
    lines.close();
    fixture.stdin.end();
    fixture.kill();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
