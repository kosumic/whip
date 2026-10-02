import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Public, real Claude Code 2.1.31 capture from issue #23142. Keep the
// third-party conversation outside tracked fixtures; pin its exact bytes.
const capture = {
  file: '11ca4767-8961-4e8e-a05f-758f26bd2edc.jsonl',
  url: 'https://gist.githubusercontent.com/kitaekatt/6881749202eea47fc54e506621378e78/raw/e103924b94e89c0c9ef21222c51eafe401bd9913/11ca4767-8961-4e8e-a05f-758f26bd2edc.jsonl',
  sha256: '1e8a88ac211335fbac6d1c504d5330ff06e58b3b028bc889909e5d23f96b71e9',
};
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.codex', 'claude-transcript-tests');
const filename = path.join(directory, capture.file);
const matches = bytes =>
  createHash('sha256').update(bytes).digest('hex') === capture.sha256;
let bytes = await readFile(filename).catch(() => null);
if (!bytes || !matches(bytes)) {
  const response = await fetch(capture.url, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`Transcript download failed: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (!matches(bytes))
    throw new Error('Published transcript checksum mismatch');
  await mkdir(directory, { recursive: true });
  await writeFile(filename, bytes);
}
console.log(
  `Verified public Claude capture: ${bytes.length} bytes, SHA-256 ${capture.sha256}`,
);
const result = spawnSync(
  'cargo',
  [
    'test',
    '--locked',
    '--manifest-path',
    'packages/react-native-whip-ssh/rust/Cargo.toml',
    'downloaded_claude_capture',
    '--',
    '--ignored',
    '--nocapture',
  ],
  {
    cwd: root,
    env: { ...process.env, WHIP_CLAUDE_CAPTURE: filename },
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
