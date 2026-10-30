#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${EAS_BUILD_PLATFORM:-}" && "${EAS_BUILD_PLATFORM}" != "ios" ]]; then
  exit 0
fi

if [[ -z "${EAS_BUILD_PLATFORM:-}" && "${WHIP_BUILD_IOS_UNIFFI:-}" != "1" && "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
build_path="$PATH"
if [[ -n "${IN_NIX_SHELL:-}" && "$(uname -s)" == "Darwin" ]]; then
  build_path="/usr/bin:/bin:/usr/sbin:/sbin:$build_path"
  export DEVELOPER_DIR="${WHIP_DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
  unset SDKROOT
elif [[ -z "${IN_NIX_SHELL:-}" ]]; then
  build_path="$HOME/.cargo/bin:$build_path"
fi
export PATH="$root_dir/node_modules/.bin:$build_path"
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-16.4}"

if ! command -v ubrn >/dev/null 2>&1; then
  echo "error: ubrn is unavailable; install dependencies before generating the iOS bridge" >&2
  exit 1
fi

if [[ "${NSH_ABOUT_EXPERIMENT:-}" == "1" ]]; then
  export DEVELOPER_DIR="${DEVELOPER_DIR:-${WHIP_DEVELOPER_DIR:-$(xcode-select -p)}}"
  export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
  export LIBCLANG_PATH="${LIBCLANG_PATH:-$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/lib}"
  export BINDGEN_EXTRA_CLANG_ARGS_aarch64_apple_ios="-isysroot $(xcrun --sdk iphoneos --show-sdk-path) --target=arm64-apple-ios$IPHONEOS_DEPLOYMENT_TARGET"
  bash "$root_dir/scripts/prepare-nsh-about.sh"
fi
node "$root_dir/scripts/ios-build-cache.cjs" bridge
