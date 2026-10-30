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

if [[ "${NSH_ABOUT_EXPERIMENT:-}" == "1" ]]; then
  # QuickJS's generated JNI bindings need Android's API 28 headers.
  ndk_toolchain="$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/$(uname -s | tr '[:upper:]' '[:lower:]')-x86_64"
  export BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android="--sysroot=$ndk_toolchain/sysroot --target=aarch64-linux-android28"
  export CC_aarch64_linux_android="$ndk_toolchain/bin/aarch64-linux-android28-clang"
  export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CC_aarch64_linux_android"
  export CFLAGS_aarch64_linux_android="--target=aarch64-none-linux-android28"
  cargo build --jobs "${CARGO_BUILD_JOBS:-2}" --locked --manifest-path "$repo_dir/packages/whip-nsh/Cargo.toml" \
    --features mobile --target "$target" --release
  source_library="$repo_dir/packages/whip-nsh/target/$target/release/libwhip_nsh.a"
else
cargo build \
  --locked \
  --manifest-path "$rust_dir/Cargo.toml" \
  --target "$target" \
  --release
fi

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
