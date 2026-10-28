#!/usr/bin/env sh
set -eu
# Run after downloading with build.sh, or set WHIP_NOTIFY_BINARY for a local build.
notify_root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
notify_binary="${WHIP_NOTIFY_BINARY:-$notify_root/whip-notify}"
notify_dest="${WHIP_NOTIFY_INSTALL_DIR:-$HOME/.local/share/whip-notify}"
mkdir -p "$notify_dest"
chmod 700 "$notify_dest"
install -m 700 "$notify_binary" "$notify_dest/whip-notify"
install -m 600 "$notify_root/herdr-plugin.toml" "$notify_dest/herdr-plugin.toml"
herdr plugin link "$notify_dest"
printf 'Installed Whip notifications. Enable it from Whip for each saved host/session.\n'
