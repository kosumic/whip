#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd "$(dirname "$0")/.." && pwd)"
source_dir="$root_dir/packages/whip-nsh/upstream"
revision=201d780a9339b886ac87c741d3d4fd8fb64e1d30
if [[ ! -d "$source_dir/.git" ]]; then
  git clone --no-checkout --depth 1 https://github.com/longbridge/nsh.git "$source_dir"
fi
if [[ "$(git -C "$source_dir" rev-parse HEAD)" != "$revision" ]]; then
  git -C "$source_dir" fetch --depth 1 origin "$revision"
  git -C "$source_dir" checkout --detach "$revision"
else
  git -C "$source_dir" checkout --detach "$revision"
fi
patch_file="$root_dir/packages/whip-nsh/patches/shared-runtime.patch"
if git -C "$source_dir" apply --check "$patch_file" 2>/dev/null; then
  git -C "$source_dir" apply "$patch_file"
elif ! git -C "$source_dir" apply --reverse --check "$patch_file"; then
  echo 'error: NSH snapshot differs from the pinned Whip patch' >&2
  exit 1
fi
