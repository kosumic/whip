#!/usr/bin/env sh
set -eu
# Herdr invokes build commands in the manifest directory. Keep this package
# independent of Whip's mobile toolchain, npm, and WhipAir.
notify_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cargo build --release --locked --manifest-path "$notify_root/Cargo.toml" --target-dir "$notify_root/target"
install -m 700 "$notify_root/target/release/whip-notify" "$notify_root/whip-notify"
