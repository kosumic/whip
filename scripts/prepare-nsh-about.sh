#!/usr/bin/env bash
# Run inside nix develop. No prebuilt NSH Rust framework or AAR is linked.
set -euo pipefail
root_dir="$(cd "$(dirname "$0")/.." && pwd)"
nsh_dir="$root_dir/packages/whip-nsh"
source_dir="$nsh_dir/upstream"
if [[ "$(uname -s)" == "Darwin" ]]; then
  export DEVELOPER_DIR="${WHIP_DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
  export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
  export LIBCLANG_PATH="${LIBCLANG_PATH:-$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/lib}"
  unset SDKROOT
fi
bash "$root_dir/scripts/prepare-nsh-source.sh"
if [[ ! -s "$root_dir/assets/licenses/nsh-dependencies.txt" ]]; then
  bash "$root_dir/scripts/generate-nsh-notices.sh"
fi
# NSH packages imported assets inside the entry's project directory. Stage the
# existing originals here so release URLs stay relative on both mobile hosts.
mkdir -p "$nsh_dir/assets"
cp "$root_dir/assets/whip-mark.png" "$root_dir/site/whip-install-qr.png" "$nsh_dir/assets/"
cp "$root_dir"/assets/brand/{herdr.svg,github.svg,x.svg,govue.png} "$nsh_dir/assets/"
cp "$root_dir"/assets/gui-fonts/Inter-{Regular,Medium,SemiBold}.ttf "$nsh_dir/assets/"
node "$root_dir/scripts/prepare-nsh-icons.cjs"
if [[ -z "${NSH_CLI:-}" ]]; then
  # Optimize the compiler's dependencies, but avoid a large LLVM optimization
  # pass over the CLI itself. This does not change the mobile release profile.
  cargo rustc --jobs "${CARGO_BUILD_JOBS:-2}" --locked --manifest-path "$source_dir/Cargo.toml" \
    -p nsh-cli --bin nsh --release -- -C opt-level=0 -C codegen-units=16 -C lto=off
fi
"${NSH_CLI:-$source_dir/target/release/nsh}" build "$nsh_dir/App.tsx" --release --out "$nsh_dir/bundle"

# The Java runtime is compiled with Whip. Change ONLY its library name: its JNI
# exports live beside UniFFI's existing C functions in the one combined library.
android_dir="$root_dir/packages/react-native-whip-ssh/android/nsh"
mkdir -p "$android_dir/java/com/longbridge/nsh" "$android_dir/assets/whip-nsh"
cp "$source_dir"/crates/nsh-platform-android/java/com/longbridge/nsh/*.java "$android_dir/java/com/longbridge/nsh/"
sed 's/System.loadLibrary("nsh")/System.loadLibrary("react-native-whip-ssh")/' \
  "$source_dir/crates/nsh-platform-android/java/com/longbridge/nsh/Native.java" > "$android_dir/java/com/longbridge/nsh/Native.java"
cp -R "$nsh_dir/bundle/." "$android_dir/assets/whip-nsh/"

ios_dir="$root_dir/packages/react-native-whip-ssh/ios/nsh"
mkdir -p "$ios_dir/include" "$ios_dir/whip-nsh"
cp "$source_dir/crates/nsh-platform-ios/include/nsh.h" "$ios_dir/include/"
cp -R "$nsh_dir/bundle/." "$ios_dir/whip-nsh/"
cp "$source_dir/LICENSE-APACHE" "$ios_dir/whip-nsh/NativeShell-LICENSE.txt"
