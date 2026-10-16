#!/bin/bash
set -euo pipefail
root="${API_MSG_HOME:-$HOME/Library/Application Support/ren-ai-api-msg}"
token="${1:?Usage: install-tunnel.sh PROTECTED-RAW-TOKEN-FILE}"
[[ "$root" == /* && -s "$root/compose.yml" && ! -e "$root/tunnel.token" ]] || { echo 'Installed api-msg and a new tunnel token destination required' >&2; exit 1; }
[[ "$(cat "$token")" =~ ^[A-Za-z0-9+/_=-]+$ ]] || { echo 'One raw tunnel token required' >&2; exit 1; }
umask 077
cp "$token" "$root/tunnel.token"
chmod 600 "$root/tunnel.token"
echo 'Docker tunnel token installed WITHOUT STARTING. Configure api-msg.renai.im -> http://api-msg:4700.'
