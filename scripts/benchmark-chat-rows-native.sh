#!/usr/bin/env bash
# Compare projection + actual UniFFI serialization on the host or Android
# without installing or instrumenting Whip. The baseline sources exist only in ignored artifacts.
set -euo pipefail

baseline_revision="${1:?Usage: $0 BASELINE_REV [host|android] [ADB_SERIAL]}"
root_dir="$(git rev-parse --show-toplevel)"
platform="${2:-host}"
if [[ "$platform" != host && "$platform" != android ]]; then
  echo "Expected host or android" >&2; exit 1
fi
harness_dir="$root_dir/artifacts/chat-row-extraction-$platform"
export WHIP_ROW_BENCH_ROOT="$root_dir" WHIP_ROW_BENCH_DIR="$harness_dir"
mkdir -p "$harness_dir/src"

git show "${baseline_revision}:packages/react-native-whip-ssh/rust/src/chat_rows.rs" > "$harness_dir/original-rows.rs"
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.WHIP_ROW_BENCH_ROOT;
const dir = process.env.WHIP_ROW_BENCH_DIR;
const native = join(root, 'packages/react-native-whip-ssh/rust/src');
const quote = JSON.stringify;
writeFileSync(join(dir, 'Cargo.toml'), `[package]
name = "chat-row-device-benchmark"
version = "0.0.0"
edition = "2024"
publish = false
[features]
extracted = ["dep:agent-transcript-view"]
[dependencies]
agent-transcript-core = { path = ${quote(join(root, 'crates/agent-transcript-core'))} }
agent-transcript-view = { path = ${quote(join(root, 'crates/agent-transcript-view'))}, optional = true }
serde_json = "1"
uniffi = "=0.31"
[profile.release]
codegen-units = 1
lto = "thin"
opt-level = 3
`);
const benchmark = readFileSync(join(native, 'chat_rows/benchmark.rs'), 'utf8')
  .replace(/#\[path = [^\n]*\]\nmod fixtures;\n/, '')
  .replace('use crate::agent_transcript::*;\n', '')
  .replace('use crate::AgentFileDiff;', 'use crate::AgentFileDiff;\nuse crate::agent_transcript::*;\n#[path = '+quote(join(root, 'crates/agent-transcript-view/src/rows/fixtures.rs'))+']\nmod fixtures;')
  .replace('super::tests::fixture(turns)', 'fixtures::fixture(turns)')
  .replaceAll('row_index(turns - 1)', 'u32::try_from(turns - 1).unwrap()');
writeFileSync(join(dir, 'src/benchmark.rs'), benchmark + `
#[test]
#[ignore = "device cached-poll measurements"]
fn cached_benchmark() {
    let state = fixtures::fixture(2_500);
    let mut projection = RowProjection::default();
    projection.restore(&state);
    let after = projection.poll(0, true, vec![]).revision;
    let mut totals = (0, 0, 0, 0, 0, 0);
    for _ in 0..1_000 {
        let (update, ns, allocations, bytes) = measured(|| projection.poll(after, true, vec![]));
        assert!(update.patches.is_empty());
        totals.0 += ns; totals.1 += allocations; totals.2 += bytes;
        let (wire, ns, allocations, _) = measured(|| wire_bytes(update));
        totals.3 += ns; totals.4 += allocations; totals.5 += wire;
    }
    println!("CHAT_ROWS_CACHED_BENCH={}", serde_json::json!({
        "rows": 5_000, "iterations": 1_000, "pollNs": totals.0 / 1_000,
        "pollAllocations": totals.1 / 1_000, "pollAllocatedBytes": totals.2 / 1_000,
        "encodeNs": totals.3 / 1_000, "encodeAllocations": totals.4 / 1_000,
        "wireBytes": totals.5 / 1_000
    }));
}
`);
const original = readFileSync(join(dir, 'original-rows.rs'), 'utf8')
  .replace('#[cfg(test)]\nmod benchmark;', '')
  .replace('mod owner;', '')
  .replace('#[cfg(test)]\nmod tests;', '')
  .replace('pub use owner::AgentChatRows;', '');
writeFileSync(join(dir, 'src/baseline.rs'), original);
writeFileSync(join(dir, 'src/lib.rs'), `
pub use agent_transcript_core::*;
mod agent_transcript { pub use agent_transcript_core::*; }
uniffi::setup_scaffolding!();
#[path = ${quote(join(native, 'test_allocations.rs'))}]
mod test_allocations;
mod chat_rows {
    #[cfg(not(feature = "extracted"))]
    include!("baseline.rs");
    #[cfg(feature = "extracted")]
    pub use agent_transcript_view::*;
    #[cfg(feature = "extracted")]
    use agent_transcript_view::rows::row_id;
    #[cfg(feature = "extracted")]
    mod ffi {
        use agent_transcript_view::*;
        macro_rules! native_type {
            ($kind:ident, $item:item) => { #[uniffi::remote($kind)] $item };
        }
        agent_transcript_view::view_type_schema!(native_type);
    }
    #[path = ${quote(join(dir, 'src/benchmark.rs'))}]
    mod benchmark;
}
`);
// Inner module documentation cannot appear inside include! after an attribute.
writeFileSync(join(dir, 'src/baseline.rs'), original.replace(/^\/\/!.*\n/gm, ''));
JS

adb_command=(adb)
if [[ -n "${3:-}" ]]; then adb_command+=(-s "$3"); fi
if [[ "$platform" == android ]]; then
  build_target=aarch64-linux-android
  export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$ANDROID_NDK_ROOT}"
else
  build_target="$(rustc -vV | sed -n 's/^host: //p')"
fi
declare -A benchmark_executables
export CARGO_TARGET_DIR="$harness_dir/target"
cleanup() {
  if [[ "$platform" == android ]]; then
    "${adb_command[@]}" shell rm -f /data/local/tmp/whip-chat-row-benchmark-baseline /data/local/tmp/whip-chat-row-benchmark-extracted
  fi
}
trap cleanup EXIT
for variant in baseline extracted; do
  feature_args=()
  if [[ "$variant" == extracted ]]; then feature_args+=(--features extracted); fi
  cargo test --release --target "$build_target" \
    --manifest-path "$harness_dir/Cargo.toml" "${feature_args[@]}" \
    --no-run --message-format=json > "$harness_dir/$variant-build.jsonl"
  binary_path="$(node --input-type=module - "$harness_dir/$variant-build.jsonl" <<'JS'
import { readFileSync } from 'node:fs';
const binary = readFileSync(process.argv[2], 'utf8').trim().split('\n')
  .map(line => JSON.parse(line)).find(value => value.executable && value.profile?.test);
if (!binary) throw new Error('No test executable was built');
console.log(binary.executable);
JS
)"
  benchmark_executables[$variant]="$binary_path"
  if [[ "$platform" == android ]]; then
    remote_binary="/data/local/tmp/whip-chat-row-benchmark-$variant"
    "${adb_command[@]}" push "$binary_path" "$remote_binary" >&2
    "${adb_command[@]}" shell chmod 700 "$remote_binary"
  fi
done

run_benchmark() {
  local variant="$1"
  if [[ "$platform" == android ]]; then
    "${adb_command[@]}" shell "/data/local/tmp/whip-chat-row-benchmark-$variant" \
      chat_rows::benchmark:: --ignored --nocapture --test-threads=1
  else
    "${benchmark_executables[$variant]}" \
      chat_rows::benchmark:: --ignored --nocapture --test-threads=1
  fi
}

# Warm both executables; alternate execution order to reduce thermal/order bias.
for variant in baseline extracted; do
  run_benchmark "$variant" > "$harness_dir/$variant-warmup.txt"
done
for ((sample = 1; sample <= ${WHIP_ROW_BENCH_SAMPLES:-9}; sample++)); do
  variants=(baseline extracted)
  if (( sample % 2 == 0 )); then variants=(extracted baseline); fi
  for variant in "${variants[@]}"; do
    run_benchmark "$variant" | tee "$harness_dir/$variant-$sample.txt"
  done
done
