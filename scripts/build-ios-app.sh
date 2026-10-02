#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/build-ios-app.sh [--signed|--unsigned] [--derived-data PATH]

Build and validate a thin arm64 iOS release app. The default is unsigned.
Dependencies and CocoaPods must already be installed.
EOF
}

signing=unsigned
derived_data="${WHIP_IOS_DERIVED_DATA:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --signed)
      signing=signed
      shift
      ;;
    --unsigned)
      signing=unsigned
      shift
      ;;
    --derived-data)
      [[ $# -ge 2 ]] || { echo "error: --derived-data requires a path" >&2; exit 2; }
      derived_data="$2"
      shift 2
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
  echo "error: iOS builds require macOS" >&2
  exit 1
fi

if [[ ! -d "$root_dir/ios/HerdR.xcworkspace" ]]; then
  echo "error: ios/HerdR.xcworkspace is missing; run pod install first" >&2
  exit 1
fi

if [[ -z "$derived_data" ]]; then
  derived_data="$root_dir/build/ios-device"
fi

export DEVELOPER_DIR="${WHIP_DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export WHIP_DISTRIBUTION_CHANNEL="${WHIP_DISTRIBUTION_CHANNEL:-app-store}"
unset SDKROOT

# Nix's compiler wrappers are correct for Rust bridge generation but inject
# incompatible linker flags into Apple's native build. Keep Node/Ruby on PATH,
# while removing compiler and linker overrides before invoking Xcode.
while IFS='=' read -r name _; do
  case "$name" in
    NIX_*|CC|CXX|CPP|LD|LDPLUSPLUS|AR|AS|NM|RANLIB|STRIP|LIPO|LIBTOOL)
      unset "$name"
      ;;
  esac
done < <(env)

xcode_args=(
  -quiet
  -workspace "$root_dir/ios/HerdR.xcworkspace"
  -scheme HerdR
  -configuration Release
  -sdk iphoneos
  -destination generic/platform=iOS
  -derivedDataPath "$derived_data"
  ARCHS=arm64
  ONLY_ACTIVE_ARCH=YES
  FORCE_BUNDLING=1
  "SWIFT_ACTIVE_COMPILATION_CONDITIONS=\$(inherited) WHIP_EMBEDDED_BUNDLE"
)

if [[ "$signing" == "signed" ]]; then
  xcode_args+=( -allowProvisioningUpdates )
else
  xcode_args+=(
    CODE_SIGNING_ALLOWED=NO
    CODE_SIGNING_REQUIRED=NO
    CODE_SIGN_IDENTITY=
    AD_HOC_CODE_SIGNING_ALLOWED=NO
  )
fi

/usr/bin/xcodebuild "${xcode_args[@]}" build

app_path="$derived_data/Build/Products/Release-iphoneos/HerdR.app"
binary_path="$app_path/HerdR"
info_plist="$app_path/Info.plist"

[[ -d "$app_path" ]] || { echo "error: app bundle was not produced" >&2; exit 1; }
[[ -f "$app_path/main.jsbundle" ]] || { echo "error: embedded JavaScript bundle is missing" >&2; exit 1; }
[[ -f "$binary_path" ]] || { echo "error: app executable is missing" >&2; exit 1; }
[[ -f "$info_plist" ]] || { echo "error: built Info.plist is missing" >&2; exit 1; }

node "$root_dir/scripts/app-version.cjs" --actual 'Built iOS CFBundleShortVersionString' \
  "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info_plist")"

architectures="$(/usr/bin/lipo -archs "$binary_path")"
if [[ "$architectures" != "arm64" ]]; then
  echo "error: expected a thin arm64 executable, found: $architectures" >&2
  exit 1
fi

required_usage_descriptions=(
  NSCameraUsageDescription
  NSFaceIDUsageDescription
  NSLocalNetworkUsageDescription
  NSPhotoLibraryUsageDescription
)
for key in "${required_usage_descriptions[@]}"; do
  value="$(/usr/libexec/PlistBuddy -c "Print :$key" "$info_plist" 2>/dev/null || true)"
  if [[ -z "${value//[[:space:]]/}" ]]; then
    echo "error: built Info.plist has a missing or empty $key" >&2
    exit 1
  fi
done

if [[ "$signing" == "signed" ]]; then
  /usr/bin/codesign --verify --deep --strict "$app_path"
fi

/usr/bin/file "$binary_path"
echo "Validated $signing iOS app: $app_path"
echo "WHIP_IOS_APP_PATH=$app_path"
