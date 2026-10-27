import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Real, public Pi v3 sessions, pinned to immutable gist file revisions. Keep
// third-party conversation bodies outside tracked fixtures and the offline suite.
const captures = [
  {
    file: 'reproduction.jsonl',
    url: 'https://gist.githubusercontent.com/cmgriffing/84bb13df3d3cfed747d2bdb379341a3c/raw/920d8be65eda40e3d4cb45980495c0f53d5fcf41/session2.jsonl',
    sha256: '39d230f343722c26d038511a7da3b34aa25b21705751edcb57d898c342cba749',
  },
  {
    file: 'format-session.jsonl',
    url: 'https://gist.githubusercontent.com/tunnckoCore/a40bcdcdf9bb8ef0bdd04ad01c4d2652/raw/ebddd937ff428046de0c00f56f2a112bba2e3fc5/pi-session.jsonl',
    sha256: '06ac331f80792cd876410efb4bbe683394d5962cd1300169dc50960b034c6bd8',
  },
] as const;
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.codex', 'pi-transcript-tests');
await mkdir(directory, { recursive: true });
for (const capture of captures) {
  const filename = path.join(directory, capture.file);
  const matches = (bytes: Buffer) =>
    createHash('sha256').update(bytes).digest('hex') === capture.sha256;
  let bytes = await readFile(filename).catch(() => null);
  if (!bytes || !matches(bytes)) {
    const response = await fetch(capture.url, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`Transcript download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (!matches(bytes)) throw new Error('Published transcript checksum mismatch');
    await writeFile(filename, bytes);
  }
  console.log(`Verified public Pi capture: ${capture.file}, ${bytes.length} bytes, SHA-256 ${capture.sha256}`);
}
const result = spawnSync('cargo', [
  'test', '--locked', '--lib', '--manifest-path',
  'packages/react-native-whip-ssh/rust/Cargo.toml', 'downloaded_pi_captures',
  '--', '--ignored', '--nocapture',
], {
  cwd: root,
  env: { ...process.env, WHIP_PI_CAPTURES: directory },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
