#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd "$(dirname "$0")/../.." && pwd)"
notice_file="$(mktemp)"
trap 'rm -f -- "$notice_file"' EXIT
cargo about generate --locked --fail \
  --config "$root_dir/whipair/about.toml" \
  --manifest-path "$root_dir/whipair/Cargo.toml" \
  --output-file "$notice_file" "$root_dir/whipair/about.hbs"
{
  printf '# Whipair third-party notices\n\nWhip-authored package code is MIT licensed. Adapted Tailcat address code retains\nits original BSD-3-Clause terms:\n\n'
  cat "$root_dir/crates/tailcat-client/LICENSE-BSD-3-Clause"
  printf '\n\nThe resolved Rust dependency licenses follow.\n\n'
  cat "$notice_file"
} > "$root_dir/whipair/THIRD_PARTY_NOTICES.md"
cp "$root_dir/whipair/THIRD_PARTY_NOTICES.md" "$root_dir/whipair/npm/THIRD_PARTY_NOTICES.md"
