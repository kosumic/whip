#!/usr/bin/env bash
set -euo pipefail

if [[ "${EAS_BUILD_PLATFORM:-}" != "ios" ]]; then
  exit 0
fi

if [[ "${EAS_BUILD_PROFILE:-}" == "production" ]]; then
  node scripts/check-store-billing.cjs ios
fi

if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable
fi

export PATH="$HOME/.cargo/bin:$PATH"
rustup target add aarch64-apple-ios
