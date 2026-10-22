#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/install-ios-device.sh [--device ID] [--keychain PATH]
                                     [--derived-data PATH] [--skip-deps]

Prepare, build, validate, install, and launch a signed arm64 iOS release.
Dependency setup is reused until its inputs or outputs change. --skip-deps
also skips checking Rust changes; use it only with an up-to-date native bridge.
The app is installed in place; this script never uninstalls it.
EOF
}

device="${WHIP_IOS_DEVICE:-}"
keychain="${WHIP_IOS_KEYCHAIN:-}"
derived_data="${WHIP_IOS_DERIVED_DATA:-}"
skip_deps=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device)
      [[ $# -ge 2 ]] || { echo "error: --device requires an identifier" >&2; exit 2; }
      device="$2"
      shift 2
      ;;
    --keychain)
      [[ $# -ge 2 ]] || { echo "error: --keychain requires a path" >&2; exit 2; }
      keychain="$2"
      shift 2
      ;;
    --derived-data)
      [[ $# -ge 2 ]] || { echo "error: --derived-data requires a path" >&2; exit 2; }
      derived_data="$2"
      shift 2
      ;;
    --skip-deps)
      skip_deps=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: iOS device installation requires macOS" >&2
  exit 1
fi

export DEVELOPER_DIR="${WHIP_DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export LANG="${WHIP_IOS_LANG:-en_US.UTF-8}"
export WHIP_DISTRIBUTION_CHANNEL="${WHIP_DISTRIBUTION_CHANNEL:-github}"

if [[ "$skip_deps" == false ]]; then
  nix develop "$root_dir#default" -c node "$root_dir/scripts/ios-build-cache.cjs" dependencies
fi

if [[ -z "$keychain" ]]; then
  dedicated_keychain="$HOME/Library/Keychains/WhipBuild.keychain-db"
  if [[ -f "$dedicated_keychain" ]]; then
    keychain="$dedicated_keychain"
  else
    keychain="$HOME/Library/Keychains/login.keychain-db"
  fi
fi

if [[ ! -f "$keychain" ]]; then
  echo "error: signing keychain does not exist: $keychain" >&2
  exit 1
fi

# The prompt is intentionally interactive. Unlocking and xcodebuild must remain
# in this same SSH process so codesign can access the private key.
/usr/bin/security unlock-keychain "$keychain"

if [[ -z "$derived_data" ]]; then
  derived_data="$root_dir/build/ios-device"
fi
"$root_dir/scripts/build-ios-app.sh" --signed --derived-data "$derived_data"

if [[ -z "$device" ]]; then
  device_ids="$(
    xcrun devicectl list devices \
      | /usr/bin/awk 'index($0, "connected") { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-Fa-f-]{36}$/) print $i }'
  )"
  device_count="$(printf '%s\n' "$device_ids" | /usr/bin/awk 'NF { count++ } END { print count + 0 }')"
  if [[ "$device_count" != "1" ]]; then
    echo "error: expected exactly one connected Apple device; pass --device or set WHIP_IOS_DEVICE" >&2
    xcrun devicectl list devices >&2
    exit 1
  fi
  device="$device_ids"
fi

app_path="$derived_data/Build/Products/Release-iphoneos/HerdR.app"
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Info.plist")"
xcrun devicectl device install app --device "$device" "$app_path"
if ! xcrun devicectl device process launch --device "$device" "$bundle_id"; then
  echo "warning: app installed, but launch was unavailable; unlock the device and open Whip" >&2
  exit 0
fi

echo "Installed and launched $bundle_id on $device without uninstalling existing app data."
