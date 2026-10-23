#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo 'error: native keyboard geometry checks require macOS and Xcode' >&2
  exit 1
fi
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${WHIP_DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
keyboard_sources=node_modules/react-native-keyboard-controller/ios
keyboard_build=build/keyboard-controller-regression
mkdir -p "$keyboard_build"

# Use system Xcode SDKs explicitly: Nix's SDKROOT may refer to an older SDK.
mac_sdk=$(/usr/bin/xcrun --sdk macosx --show-sdk-path)
ios_sdk=$(/usr/bin/xcrun --sdk iphoneos --show-sdk-path)
/usr/bin/xcrun swiftc -sdk "$mac_sdk" -target arm64-apple-macosx14.0 \
  "$keyboard_sources/extensions/KeyboardBottomOcclusion.swift" \
  __tests__/native/keyboardBottomOcclusion/main.swift -o "$keyboard_build/test"
"$keyboard_build/test"

# Compile the actual patched UIKit frame conversion for arm64 iOS as well.
# This validates native APIs without touching the app's Pods or signing state.
printf '#import <UIKit/UIKit.h>\n' > "$keyboard_build/UIKit.h"
/usr/bin/xcrun swiftc -sdk "$ios_sdk" -target arm64-apple-ios16.0 \
  -parse-as-library -emit-module -module-name WhipKeyboardGeometry \
  -import-objc-header "$keyboard_build/UIKit.h" \
  "$keyboard_sources/extensions/KeyboardBottomOcclusion.swift" \
  "$keyboard_sources/extensions/Notification.swift" \
  "$keyboard_sources/extensions/UIApplication.swift" \
  -o "$keyboard_build/WhipKeyboardGeometry.swiftmodule"
