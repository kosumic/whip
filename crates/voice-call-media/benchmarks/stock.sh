#!/usr/bin/env bash
# Run the exact same packet scheduler against unmodified crates.io str0m 0.25.0.
set -euo pipefail
project=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
fixture="$project/crates/voice-call-media/target/stock-handshake"
mkdir -p "$fixture/src/support"
cp "$project/crates/voice-call-media/examples/handshake_bench.rs" "$fixture/src/main.rs"
cp "$project/crates/voice-call-media/examples/support/handshake.rs" "$fixture/src/support/handshake.rs"
cat > "$fixture/Cargo.toml" <<'MANIFEST'
[package]
name = "stock-handshake"
version = "0.0.0"
edition = "2024"
[features]
sped-benchmark = []
[dependencies]
str0m = { version = "=0.25.0", default-features = false, features = ["aws-lc-rs"] }
MANIFEST
cp "$project/crates/voice-call-media/benchmarks/stock.Cargo.lock" "$fixture/Cargo.lock"
cargo run --locked --release --manifest-path "$fixture/Cargo.toml" -- "${@}"
