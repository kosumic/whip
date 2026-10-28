#!/usr/bin/env sh
set -eu
# Herdr runs this before registering the plugin. No compiler is needed on hosts.
umask 077
notify_root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
notify_version=$(sed -n 's/^version = "\([0-9][0-9.]*\)"$/\1/p' "$notify_root/herdr-plugin.toml")
[ -n "$notify_version" ] || { echo 'Invalid notification plugin version' >&2; exit 1; }
. "$notify_root/platform.sh"
notify_target=$(notify_release_target)
command -v curl >/dev/null 2>&1 || { echo 'Install curl on this host first' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  notify_hash=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  notify_hash=shasum
else
  echo 'Install sha256sum or shasum on this host first' >&2
  exit 1
fi
notify_asset="whip-notify-$notify_target"
notify_url="https://github.com/kosumic/whip/releases/download/whip-notify-v$notify_version/$notify_asset"
notify_tmp=$(mktemp -d "$notify_root/.whip-notify-download.XXXXXX")
trap 'rm -rf "$notify_tmp"' EXIT
trap 'exit 1' HUP INT TERM
notify_download() {
  curl -q --fail --location --silent --show-error \
    --proto '=https' --proto-redir '=https' --connect-timeout 10 \
    --max-time "$4" --speed-limit 1024 --speed-time 20 \
    --retry 0 --max-filesize "$3" \
    --output "$2" "$1"
}
# Fail stalled transfers early, within Whip's three-minute installation deadline.
if ! notify_download "$notify_url.sha256" "$notify_tmp/checksum" 1024 15 ||
   ! notify_download "$notify_url" "$notify_tmp/$notify_asset" 67108864 90; then
  printf 'Could not download notification plugin %s. Check host network access and GitHub release availability.\n' "$notify_version" >&2
  exit 1
fi
IFS=' ' read -r notify_expected notify_filename < "$notify_tmp/checksum" || {
  echo 'Missing or incomplete notification plugin checksum' >&2; exit 1;
}
case "$notify_expected" in
  ''|*[!0-9a-f]*) echo 'Invalid notification plugin checksum' >&2; exit 1 ;;
esac
if [ "${#notify_expected}" -ne 64 ] || [ "$notify_filename" != "$notify_asset" ]; then
  echo 'Invalid notification plugin checksum or asset name' >&2
  exit 1
fi
if [ "$notify_hash" = sha256sum ]; then
  notify_actual=$(sha256sum "$notify_tmp/$notify_asset")
else
  notify_actual=$(shasum -a 256 "$notify_tmp/$notify_asset")
fi
if [ "${notify_actual%% *}" != "$notify_expected" ]; then
  echo 'Notification plugin checksum mismatch; installation aborted' >&2
  exit 1
fi
chmod 700 "$notify_tmp/$notify_asset"
# Both paths are on the same filesystem. A failed download leaves the old binary.
[ ! -d "$notify_root/whip-notify" ] || { echo 'Plugin executable is a directory' >&2; exit 1; }
mv -f "$notify_tmp/$notify_asset" "$notify_root/whip-notify"
printf 'Downloaded Whip notification plugin %s (%s).\n' "$notify_version" "$notify_target"
