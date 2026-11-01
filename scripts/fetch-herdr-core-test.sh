#!/usr/bin/env bash
# Pinned upstream test server; never changes the user's installed hc or session.
set -euo pipefail
destination="${1:?usage: fetch-herdr-core-test.sh DESTINATION}"
case "$(uname -s)-$(uname -m)" in
  Linux-aarch64|Linux-arm64) platform=linux-aarch64; checksum=b6573137d70baff24fb346c957a9879af6bdc4c641188cdf9e47a7b2a677bc92 ;;
  Darwin-arm64) platform=macos-aarch64; checksum=698d8f0c44f4e4b15fec174d52a39d57a014cfd71added44b53a0753b469d0fd ;;
  Linux-x86_64) platform=linux-x86_64; checksum=58d6861176dc6fe905b58880d5bff07a9959be613a98e5d66b4583b04b6cfa45 ;;
  *) echo 'No pinned core test binary for this platform' >&2; exit 1 ;;
esac
mkdir -p "$destination"
archive="$destination/core.tar.gz"
curl --fail --silent --show-error --location --retry 3 "https://releases.herdr.dev/core/0.1.16/herdr-core-$platform.tar.gz" --output "$archive"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$archive")"; else actual="$(shasum -a 256 "$archive")"; fi
if [[ "${actual%% *}" != "$checksum" ]]; then echo 'core test archive checksum mismatch' >&2; exit 1; fi
tar -xzf "$archive" -C "$destination"
printf '%s/herdr-core\n' "$(cd "$destination" && pwd)"
