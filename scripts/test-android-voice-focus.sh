#!/usr/bin/env bash
# Start a Whip voice call, then run: nix develop -c bash scripts/test-android-voice-focus.sh transient
set -euo pipefail
mode="${1:-transient}"
case "$mode" in transient|duck|permanent) ;; *) echo 'Expected transient, duck, or permanent' >&2; exit 2 ;; esac
root="$(cd "$(dirname "$0")/.." && pwd)"
sdk="${ANDROID_HOME:?Run this script with nix develop}"
tools="$sdk/build-tools/37.0.0"
platform="$sdk/platforms/android-37.0/android.jar"
build="$root/build/voice-focus-probe"
source="$root/android/voice-focus-probe"
mkdir -p "$build/classes" "$build/dex"
"$tools/aapt2" link -o "$build/probe.apk" --manifest "$source/AndroidManifest.xml" -I "$platform"
javac --release 11 -cp "$platform" -d "$build/classes" "$source/FocusProbeActivity.java"
"$tools/d8" --lib "$platform" --min-api 26 --output "$build/dex" "$build/classes/io/github/kaminarios/whip/focusprobe/FocusProbeActivity.class"
jar --update --file "$build/probe.apk" -C "$build/dex" classes.dex
"$tools/zipalign" -f 4 "$build/probe.apk" "$build/probe-aligned.apk"
"$tools/apksigner" sign --ks "$root/android/app/debug.keystore" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey --out "$build/probe-signed.apk" "$build/probe-aligned.apk"
adb install -r "$build/probe-signed.apk"
adb shell am start -W -n io.github.kaminarios.whip.focusprobe/.FocusProbeActivity --es mode "$mode"
