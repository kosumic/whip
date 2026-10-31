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

# EAS macOS images support Homebrew for additional build dependencies. Local
# device builds use the Go toolchain provided by nix develop instead.
if ! command -v go >/dev/null 2>&1; then
  HOMEBREW_NO_AUTO_UPDATE=1 brew install go
fi
go version
