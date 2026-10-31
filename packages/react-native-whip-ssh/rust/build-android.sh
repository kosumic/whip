#!/usr/bin/env bash
set -euo pipefail

rust_dir="$(cd "$(dirname "$0")" && pwd)"
module_dir="$(cd "$rust_dir/.." && pwd)"
repo_dir="$(cd "$module_dir/../.." && pwd)"
target="aarch64-linux-android"
source_library="$rust_dir/target/$target/release/libwhip_ssh.a"
destination_library="$module_dir/android/src/main/jniLibs/arm64-v8a/libwhip_ssh.a"
tailcat_library="$module_dir/android/build/tailcat/arm64-v8a/libtailcat.so"
ubrn="$repo_dir/node_modules/.bin/ubrn"

if [[ ! -x "$ubrn" ]]; then
  echo "error: $ubrn is unavailable; install dependencies before building Android" >&2
  exit 1
fi

build_messages="$(mktemp)"
trap 'rm -f "$build_messages"' EXIT
cargo build \
  --locked \
  --manifest-path "$rust_dir/Cargo.toml" \
  --target "$target" \
  --release \
  --message-format=json-render-diagnostics > "$build_messages"

# Cargo reports cached build-script outputs too, so cleaning Android's build
# directory can restore the shared library without rebuilding the Go runtime.
node - "$build_messages" "$tailcat_library" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const messages = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(line => JSON.parse(line));
const build = messages.findLast(message => message.reason === 'build-script-executed'
  && message.package_id.includes('#whip-ssh@'));
if (!build) throw new Error('Cargo did not report the Whip Tailcat build output');
fs.mkdirSync(path.dirname(process.argv[3]), { recursive: true });
fs.copyFileSync(path.join(build.out_dir, 'libtailcat.so'), process.argv[3]);
JS

install -D -m 0644 "$source_library" "$destination_library"

(
  cd "$rust_dir"
  "$ubrn" generate jsi bindings \
    --library \
    --ts-dir "$module_dir/src/generated" \
    --cpp-dir "$module_dir/cpp/generated" \
    "$source_library"
)
node "$repo_dir/scripts/instrument-terminal-bindings.ts"
