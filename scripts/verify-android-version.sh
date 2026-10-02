#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
artifact="${1:?Usage: bash scripts/verify-android-version.sh ARTIFACT.apk|ARTIFACT.aab}"

case "$artifact" in
  *.apk)
    actual="$(apkanalyzer manifest version-name "$artifact")"
    ;;
  *.aab)
    actual="$(java -jar "${BUNDLETOOL_JAR:?Set BUNDLETOOL_JAR to bundletool-all.jar}" dump manifest \
      --bundle="$artifact" --module=base --xpath='/manifest/@android:versionName')"
    ;;
  *)
    echo "error: unsupported Android artifact: $artifact" >&2
    exit 1
    ;;
esac

node "$root_dir/scripts/app-version.cjs" --actual "$artifact versionName" "$actual"
echo "Verified $artifact versionName: $actual"
