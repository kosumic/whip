#!/usr/bin/env bash
set -euo pipefail
if [[ "${NSH_ABOUT_EXPERIMENT:-}" == "1" ]]; then
  exec bash "$(dirname "$0")/prepare-nsh-about.sh"
fi
