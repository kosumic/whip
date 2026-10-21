#!/usr/bin/env bash
set -euo pipefail

# Keep the 3D preview off the workstation's unstable hardware WebGL path.
exec "${HYPERFRAMES_REVIEW_BROWSER:-/home/kosumi/.nix-profile/bin/brave}" \
  --use-gl=angle \
  --use-angle=swiftshader \
  --enable-unsafe-swiftshader \
  --enable-webgl \
  --disable-gpu-compositing \
  --autoplay-policy=no-user-gesture-required \
  --disable-background-media-suspend \
  --no-first-run \
  --no-default-browser-check \
  "$@"
