#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd "$(dirname "$0")/.." && pwd)"
exec "${NSH_CLI:-$root_dir/packages/whip-nsh/upstream/target/release/nsh}" "$@"
