// Run from the repo root: nix develop .#tailcat-tests -c node whipair/tests/tailcat-builtin.cjs
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');

async function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) throw new Error(`${command} failed (${signal ?? code})`);
}

async function main() {
  if (process.platform !== 'linux') throw new Error('Run on Linux to isolate upstream SSH keys with XDG_CONFIG_HOME');
  const root = process.cwd();
  const target = path.join(root, 'crates/tailcat-client/target');
  const bin = path.join(target, 'pairing-bin');
  mkdirSync(bin, { recursive: true });
  const fixture = path.join(target, 'tailcat-pairing-reference');
  const reference = path.join(root, 'crates/tailcat-client/tests/reference');
  await run('go', ['test', '-mod=readonly', '-c', '-o', fixture], { cwd: reference });
  await run('go', ['build', '-mod=readonly', '-o', path.join(bin, 'tailcat'), 'github.com/tailscale/tailcat/cmd/tailcat'], { cwd: reference });
  const directory = mkdtempSync(path.join(root, '.codex-builtin-pairing-'));
  const environment = { ...process.env, XDG_CONFIG_HOME: directory, PATH: `${bin}:${process.env.PATH}` };
  const server = spawn(fixture, ['-test.run=^TestWhipBuiltinPairing$'], { env: environment, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: server.stdout });
  try {
    const address = await Promise.race([
      (async () => {
        for await (const line of lines) {
          try {
            const value = JSON.parse(line);
            if (value.address) return value.address;
          } catch { /* Go test output also contains ordinary status lines. */ }
        }
        throw new Error('Tailcat fixture exited before publishing its address');
      })(),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Tailcat fixture startup timed out')), 30000); timer.unref(); }),
    ]);
    const env = { ...environment, WHIP_BUILTIN_TAILCAT_ADDRESS: address, WHIP_BUILTIN_PAIRING_CODE_FILE: path.join(directory, 'code') };
    await run('cargo', ['test', '--locked', '--manifest-path', 'whipair/Cargo.toml', 'live_builtin_tailcat_pairing', '--', '--ignored'], { env });
    await run('cargo', ['test', '--locked', '--manifest-path', 'packages/react-native-whip-ssh/rust/Cargo.toml', 'live_builtin_tailcat_pairing_and_reconnect', '--', '--ignored', '--test-threads=1'], { env });
  } finally {
    lines.close();
    server.stdin.end();
    const stopped = once(server, 'close');
    server.kill('SIGTERM');
    await stopped;
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
