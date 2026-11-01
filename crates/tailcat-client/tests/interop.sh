#!/usr/bin/env bash
set -euo pipefail

crate_dir="$(cd "$(dirname "$0")/.." && pwd)"
fixture="$crate_dir/target/tailcat-reference"
mkdir -p "$crate_dir/target"
(cd "$crate_dir/tests/reference" && go test -mod=readonly -c -o "$fixture")
WHIP_TAILCAT_REFERENCE="$fixture" cargo test --locked --manifest-path "$crate_dir/Cargo.toml" \
  --test interop -- --ignored --nocapture
