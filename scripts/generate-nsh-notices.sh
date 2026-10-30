#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root_dir"
cargo about generate --locked --fail \
  --manifest-path packages/whip-nsh/Cargo.toml --features mobile \
  --target aarch64-apple-ios,aarch64-linux-android \
  --config packages/whip-nsh/about.toml \
  --output-file assets/licenses/nsh-dependencies.txt licenses/cargo/about.txt.hbs
