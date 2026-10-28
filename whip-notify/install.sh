#!/usr/bin/env sh
set -eu
# Run on the Herdr host after building this independent package.
notify_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
notify_dest="${WHIP_NOTIFY_INSTALL_DIR:-$HOME/.local/share/whip-notify}"
mkdir -p "$notify_dest"
chmod 700 "$notify_dest"
install -m 700 "$notify_root/target/release/whip-notify" "$notify_dest/whip-notify"
install -m 600 "$notify_root/herdr-plugin.toml" "$notify_dest/herdr-plugin.toml"
herdr plugin link "$notify_dest"
printf 'Installed Whip notifications. Enable it from Whip for each saved host/session.\n'
