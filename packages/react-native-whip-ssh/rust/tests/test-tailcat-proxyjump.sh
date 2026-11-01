#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
  echo "error: run this fixture on Linux so upstream Tailcat SSH keys stay in isolated XDG configuration" >&2
  exit 1
fi

rust_dir="$(cd "$(dirname "$0")/.." && pwd)"
reference_dir="$rust_dir/../../../crates/tailcat-client/tests/reference"
fixture="$rust_dir/target/tailcat-proxyjump-reference"
mkdir -p "$rust_dir/target"
(cd "$reference_dir" && "${GO:-go}" test -mod=readonly -c -o "$fixture")
WHIP_TAILCAT_PROXYJUMP_REFERENCE="$fixture" cargo test --locked \
  --manifest-path "$rust_dir/Cargo.toml" --lib \
  tailcat_first_hop_proxyjump_end_to_end -- --ignored --nocapture
