#!/usr/bin/env bash
# Publish the exact crates.io artifact under its existing package tag.
set -euo pipefail

if [[ $# != 2 ]]; then
  echo "Usage: $0 CRATE VERSION" >&2
  exit 1
fi
: "${GH_REPO:?Set GH_REPO to the GitHub owner/repository}"
crate="$1"
version="$2"
tag="$crate-v$version"
registry="https://crates.io/api/v1/crates/$crate/$version"
user_agent="whip-release/0.1 (+https://github.com/$GH_REPO)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

curl --fail --silent --show-error --retry 3 --user-agent "$user_agent" \
  "$registry" --output "$temporary/registry.json"
jq --exit-status --arg crate "$crate" --arg version "$version" \
  '.version | .crate == $crate and .num == $version and .license == "MIT" and .yanked == false' \
  "$temporary/registry.json" >/dev/null
checksum="$(jq --exit-status --raw-output '.version.checksum' "$temporary/registry.json")"
description="$(jq --exit-status --raw-output '.version.description // empty' "$temporary/registry.json")"
archive="$crate-$version.crate"
curl --fail --location --silent --show-error --retry 3 --user-agent "$user_agent" \
  "$registry/download" --output "$temporary/$archive"
printf '%s  %s\n' "$checksum" "$archive" > "$temporary/$archive.sha256"
(
  cd "$temporary"
  sha256sum --check "$archive.sha256"
)

# Existing public releases may be immutable or have manually edited notes.
if draft="$(gh release view "$tag" --repo "$GH_REPO" --json isDraft --jq .isDraft 2>/dev/null)"; then
  if [[ "$draft" == false ]]; then
    echo "GitHub Release $tag is already published."
    exit 0
  fi
else
  cat > "$temporary/notes.md" <<EOF
$description

Published on [crates.io](https://crates.io/crates/$crate/$version) under the MIT license.
Third-party code and dependencies retain their original license notices.

Add to your Cargo dependencies:

\`\`\`toml
$crate = "$version"
\`\`\`

[API documentation](https://docs.rs/$crate/$version) · [Usage and source](https://github.com/$GH_REPO/tree/$tag/crates/$crate)

The attached crate is the unchanged crates.io package, verified against its registry SHA-256 checksum.
EOF
  gh release create "$tag" --repo "$GH_REPO" --verify-tag --draft --latest=false \
    --title "$crate $version" --notes-file "$temporary/notes.md"
fi

gh release upload "$tag" --repo "$GH_REPO" \
  "$temporary/$archive" "$temporary/$archive.sha256" --clobber
gh release edit "$tag" --repo "$GH_REPO" --draft=false --latest=false
