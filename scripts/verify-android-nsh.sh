#!/usr/bin/env bash
# Inspect the final packaged library: RN autolinking can otherwise select a
# core-only copy even when the library module compiled NSH successfully.
set -euo pipefail
root_dir="$(cd "$(dirname "$0")/.." && pwd)"
artifact="${1:?Usage: bash scripts/verify-android-nsh.sh APP.apk}"
toolchain="${ANDROID_NDK_ROOT:-${ANDROID_NDK_HOME:-}}/toolchains/llvm/prebuilt/$(uname -s | tr '[:upper:]' '[:lower:]')-x86_64/bin"
nm="${WHIP_ANDROID_NM:-$toolchain/llvm-nm}"
if [[ ! -x "$nm" ]]; then
  echo 'error: use nix develop or set WHIP_ANDROID_NM to the NDK llvm-nm' >&2
  exit 1
fi
mkdir -p "$root_dir/build"
temporary_dir="$(mktemp -d "$root_dir/build/nsh-apk-check.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT
library='lib/arm64-v8a/libreact-native-whip-ssh.so'
unzip -p "$artifact" "$library" > "$temporary_dir/whip.so"
"$nm" --dynamic --defined-only "$temporary_dir/whip.so" | awk '{ print $NF }' > "$temporary_dir/exports"
core_constructor='uniffi_whip_ssh_fn_constructor_appcore_new'
for symbol in JNI_OnLoad "$core_constructor" Java_com_whipssh_WhipNshViews_initialize \
  Java_com_longbridge_nsh_Native_create Java_com_longbridge_nsh_Native_destroy; do
  if ! grep -Fxq "$symbol" "$temporary_dir/exports"; then
    echo "error: packaged $library is missing $symbol" >&2
    exit 1
  fi
done
unzip -p "$artifact" assets/whip-nsh/bundle.nshc > "$temporary_dir/bundle.nshc"
test -s "$temporary_dir/bundle.nshc"
unzip -Z1 "$artifact" > "$temporary_dir/entries"
test "$(grep -Fxc "$library" "$temporary_dir/entries")" = 1
if grep -Eq '^lib/[^/]+/libnsh\.so$' "$temporary_dir/entries"; then
  echo 'error: NSH must share Whip’s native library, not add libnsh.so' >&2
  exit 1
fi
while IFS= read -r other_library; do
  [[ "$other_library" == "$library" ]] && continue
  unzip -p "$artifact" "$other_library" > "$temporary_dir/other.so"
  "$nm" --dynamic --defined-only "$temporary_dir/other.so" | awk '{ print $NF }' > "$temporary_dir/other-exports"
  if grep -Fxq 'Java_com_longbridge_nsh_Native_create' "$temporary_dir/other-exports" ||
      grep -Fxq "$core_constructor" "$temporary_dir/other-exports"; then
    echo "error: Rust core or NSH is duplicated in $other_library" >&2
    exit 1
  fi
done < <(grep -E '^lib/arm64-v8a/[^/]+\.so$' "$temporary_dir/entries")
echo "Verified NSH JNI initialization, engine exports and bytecode in $artifact"
