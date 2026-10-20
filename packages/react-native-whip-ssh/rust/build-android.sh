#!/usr/bin/env bash
set -euo pipefail

rust_dir="$(cd "$(dirname "$0")" && pwd)"
module_dir="$(cd "$rust_dir/.." && pwd)"
repo_dir="$(cd "$module_dir/../.." && pwd)"
target="aarch64-linux-android"
source_library="$rust_dir/target/$target/release/libwhip_ssh.a"
destination_library="$module_dir/android/src/main/jniLibs/arm64-v8a/libwhip_ssh.a"
ubrn="$repo_dir/node_modules/.bin/ubrn"

if [[ ! -x "$ubrn" ]]; then
  echo "error: $ubrn is unavailable; install dependencies before building Android" >&2
  exit 1
fi

cargo build \
  --locked \
  --manifest-path "$rust_dir/Cargo.toml" \
  --target "$target" \
  --release

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
