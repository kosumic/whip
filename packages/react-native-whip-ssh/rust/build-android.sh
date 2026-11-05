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

# The bundled Opus CMake build uses ANDROID_NDK_HOME; Nix exports ROOT.
if [[ -z "${ANDROID_NDK_HOME:-}" && -n "${ANDROID_NDK_ROOT:-}" ]]; then
  export ANDROID_NDK_HOME="$ANDROID_NDK_ROOT"
fi

cargo build \
  --locked \
  --manifest-path "$rust_dir/Cargo.toml" \
  --target "$target" \
  --release

# AWS-LC probes sdallocx as an optional weak function. React Native's Folly
# exports the same name as a data pointer, which makes crypto initialization
# jump into .bss on Android. Namespace the Rust archive's reference so AWS-LC
# takes its normal libc free fallback; Folly's own references stay unchanged.
objcopy_candidates=("${ANDROID_NDK_HOME:?Android NDK is required}/toolchains/llvm/prebuilt/"*/bin/llvm-objcopy)
if [[ ${#objcopy_candidates[@]} -ne 1 || ! -x "${objcopy_candidates[0]}" ]]; then
  echo "error: expected one Android NDK llvm-objcopy executable" >&2
  exit 1
fi
install -d "$(dirname "$destination_library")"
"${objcopy_candidates[0]}" \
  --redefine-sym sdallocx=whip_crypto_sdallocx \
  "$source_library" "$destination_library"
chmod 0644 "$destination_library"

(
  cd "$rust_dir"
  "$ubrn" generate jsi bindings \
    --library \
    --ts-dir "$module_dir/src/generated" \
    --cpp-dir "$module_dir/cpp/generated" \
    "$source_library"
)
node "$repo_dir/scripts/instrument-terminal-bindings.ts"
