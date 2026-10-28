#!/usr/bin/env sh
set -eu

# Herdr fetches the entire tree at the install ref. Keep that tree independent
# of the app's source, media assets and history while retaining managed upgrades.
notify_source=${1:-HEAD}
notify_version=$(git show "$notify_source:whip-notify/herdr-plugin.toml" | sed -n 's/^version = "\([0-9][0-9.]*\)"$/\1/p')
[ -n "$notify_version" ] || { echo 'Invalid notification plugin version' >&2; exit 1; }
for notify_file in build.sh herdr-plugin.toml platform.sh; do
  git cat-file -e "$notify_source:whip-notify/$notify_file"
done
notify_entries=$(git ls-tree "$notify_source:whip-notify" -- build.sh herdr-plugin.toml platform.sh)
notify_plugin_tree=$(printf '%s\n' "$notify_entries" | git mktree)
notify_tree=$(printf '040000 tree %s\twhip-notify\n' "$notify_plugin_tree" | git mktree)
notify_tag="whip-notify-install-v$notify_version"
notify_ref="refs/tags/$notify_tag"
if git show-ref --verify --quiet "$notify_ref"; then
  if [ "$(git rev-parse "$notify_ref^{tree}")" != "$notify_tree" ]; then
    echo 'Published installer tag differs; increment the plugin version instead of replacing it' >&2
    exit 1
  fi
else
  notify_commit=$(git -c user.name='Whip plugin releases' -c user.email='notify@whip.kosumi.dev' \
    commit-tree "$notify_tree" -m "Notification plugin $notify_version installer")
  git update-ref "$notify_ref" "$notify_commit" ''
fi
printf '%s\n' "$notify_tag"
