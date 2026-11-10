#!/usr/bin/env sh
# Install only the push watcher. Never changes Core or provider configurations.
set -eu
umask 077
notify_version=0.1.6
notify_socket=${WHIP_NOTIFY_CORE_SOCKET:-}
if [ "${1:-}" = --socket ]; then notify_socket=${2:-}; fi
case "$notify_socket" in /*) ;; *) echo 'Pass --socket with the running Core socket path' >&2; exit 1 ;; esac
case "${XDG_DATA_HOME:-}" in /*) notify_data=$XDG_DATA_HOME ;; *) notify_data="$HOME/.local/share" ;; esac
notify_root="$notify_data/whip-notify/core"
mkdir -p "$notify_root"
[ ! -L "$notify_root" ] || { echo 'Unsafe Core notification directory' >&2; exit 1; }
chmod 700 "$notify_root"
notify_stage=$(mktemp -d "$notify_root/.install.XXXXXX")
trap 'rm -rf "$notify_stage"' EXIT
trap 'exit 1' HUP INT TERM
notify_source="https://raw.githubusercontent.com/kosumic/whip/whip-notify-install-v$notify_version/whip-notify"
for notify_file in build.sh platform.sh herdr-plugin.toml; do
  curl -q --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
    --connect-timeout 5 --max-time 10 --max-filesize 65536 \
    --output "$notify_stage/$notify_file" "$notify_source/$notify_file"
done
notify_manifest_version=$(sed -n 's/^version = "\([0-9][0-9.]*\)"$/\1/p' "$notify_stage/herdr-plugin.toml")
[ "$notify_manifest_version" = "$notify_version" ] || { echo 'Core push installer version mismatch' >&2; exit 1; }
sh "$notify_stage/build.sh" >&2
notify_binary="$notify_root/whip-notify"
[ ! -d "$notify_binary" ] || { echo 'Core notification executable is a directory' >&2; exit 1; }
mv -f "$notify_stage/whip-notify" "$notify_binary"
"$notify_binary" core --socket "$notify_socket" install
