#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
remote_url="$(git -C "$repo_root" remote get-url origin)"
pages_branch=gh-pages
publish_dir="$(mktemp -d "$repo_root/.codex-store-page.XXXXXX")"
trap 'rm -rf -- "$publish_dir"' EXIT

git init --quiet --initial-branch="$pages_branch" "$publish_dir"
git -C "$publish_dir" remote add origin "$remote_url"

if [[ -n "$(git -C "$publish_dir" ls-remote --heads origin "$pages_branch")" ]]; then
  git -C "$publish_dir" fetch --quiet --depth=1 origin "$pages_branch"
  git -C "$publish_dir" checkout --quiet -B "$pages_branch" FETCH_HEAD
fi

cp "$repo_root"/site/{index.html,styles.css,store-redirect.js,whip-install-qr.svg,whip-install-qr.png} "$publish_dir/"
touch "$publish_dir/.nojekyll"
git -C "$publish_dir" add index.html styles.css store-redirect.js whip-install-qr.svg whip-install-qr.png .nojekyll

if git -C "$publish_dir" diff --cached --quiet; then
  echo 'The published store page is already up to date.'
  exit 0
fi

git -C "$publish_dir" \
  -c user.name="$(git -C "$repo_root" config user.name)" \
  -c user.email="$(git -C "$repo_root" config user.email)" \
  commit --quiet -m 'feat: publish Whip store download page'
git -C "$publish_dir" push origin "HEAD:refs/heads/$pages_branch"
