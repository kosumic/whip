#!/usr/bin/env bash
set -euo pipefail

rust_dir="$(cd "$(dirname "$0")/.." && pwd)"
go_tool="${GO:-go}"
fixture="$rust_dir/target/tailcat-test-relay"
mkdir -p "$rust_dir/target"
(cd "$rust_dir/tailcat" && "$go_tool" test -mod=readonly -c -o "$fixture")
WHIP_TAILCAT_TEST_RELAY="$fixture" cargo test --locked --manifest-path "$rust_dir/Cargo.toml" ssh::tailcat::tests -- --include-ignored --skip live_remote_ssh_over_tailcat --nocapture
