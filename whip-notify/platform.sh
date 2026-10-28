#!/usr/bin/env sh

notify_release_target() {
  notify_platform=$(uname -s)
  notify_arch=$(uname -m)
  case "$notify_platform:$notify_arch" in
    Linux:aarch64|Linux:arm64) printf '%s\n' aarch64-unknown-linux-musl ;;
    Linux:x86_64|Linux:amd64) printf '%s\n' x86_64-unknown-linux-musl ;;
    Darwin:arm64|Darwin:aarch64) printf '%s\n' aarch64-apple-darwin ;;
    *)
      printf 'No prebuilt Whip notification plugin for %s/%s. Supported hosts: Linux arm64/x86_64 and Apple Silicon macOS.\n' "$notify_platform" "$notify_arch" >&2
      return 1
      ;;
  esac
}
