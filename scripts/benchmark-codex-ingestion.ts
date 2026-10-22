// Desktop release microbenchmark. Run inside nix develop.
import { execFileSync } from 'node:child_process';

const marker = 'CODEX_INGESTION_BENCH=';
const log = execFileSync('cargo', [
  'test', '--locked', '--release', '--lib', '--manifest-path',
  'packages/react-native-whip-ssh/rust/Cargo.toml',
  'agent_transcript::codex::benchmark::ingestion_benchmark', '--',
  '--ignored', '--nocapture', '--test-threads=1',
], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
const line = log.split('\n').find(value => value.includes(marker));
if (!line) throw new Error('Codex ingestion benchmark produced no measurements');

console.log(JSON.stringify({
  platform: process.platform,
  arch: process.arch,
  rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(),
  scope: 'Release Rust on the measured thread. Synthetic legacy and paginated histories. '
    + 'Adapter replay starts from parsed JSON; ingestion includes framing, parsing, raw-line caching and updates; '
    + 'cache restoration includes cache parsing, raw-record replay and the returned full transcript snapshot. '
    + 'Fixture creation, cache serialization, validation and final output destruction are excluded. '
    + 'Peak bytes are the maximum live-byte increase during the operation, not process RSS. '
    + 'Excludes SSH, database I/O, FFI, row projection and UI work.',
  ...JSON.parse(line.slice(line.indexOf(marker) + marker.length)) as Record<string, unknown>,
}, null, 2));
