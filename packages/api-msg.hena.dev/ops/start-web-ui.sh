#!/bin/bash
set -euo pipefail

if [[ "${1:-}" != --isolated ]]; then
  root="$HOME/.local/state/ren-ai/web-ui"
  script="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  cd "$root/home"
  exec /usr/bin/env -i PATH=/usr/bin:/bin HOME="$root/home" \
    XDG_CONFIG_HOME="$root/config" XDG_DATA_HOME="$root/data" \
    XDG_CACHE_HOME="$root/cache" XDG_STATE_HOME="$root/state" \
    OPENCODE_CONFIG_DIR="$root/config" OPENCODE_CONFIG_PROJECT_DISABLE=1 \
    OPENCODE_DISABLE_MODELS_FETCH=1 /bin/bash "$script" --isolated
fi

umask 077
OPENCODE_PASSWORD="$(/usr/bin/security find-generic-password -w -s dev.hena.ren-ai.web-ui -a api-msg)"
[[ -n "$OPENCODE_PASSWORD" ]] || { echo 'Missing web UI asset-server password' >&2; exit 1; }
export OPENCODE_PASSWORD
exec /Users/chris/.local/share/ren-ai/web-ui/bin/opencode-2.0.16 serve --hostname 127.0.0.1 --port 47987
