#!/bin/bash
set -euo pipefail
snapshot="${1:?Usage: install-application-state.sh STOPPED-SNAPSHOT-APPLICATION-STATE}"
snapshot="$(cd "$snapshot" && pwd)"
[[ -s "$snapshot/server.sqlite" ]] || { echo 'Coherent application SQLite snapshot is required' >&2; exit 1; }
volume="${REN_AI_STATE_VOLUME:-ren-ai-application-state}"
[[ -z "$(docker ps --filter "volume=$volume" --format '{{.ID}}')" ]] || { echo 'Destination volume is mounted by a running service' >&2; exit 1; }
docker volume create "$volume" >/dev/null
docker run --rm --network none --mount "type=volume,src=$volume,dst=/state" --mount "type=bind,src=$snapshot,dst=/input,readonly" alpine:3.22.1 sh -eu -c '
  test -z "$(ls -A /state)" || { echo "Application state already exists; refusing overwrite" >&2; exit 1; }
  cp -a /input/. /state/
  chmod 700 /state
  chmod 600 /state/server.sqlite
'
echo 'Imported all application-owned state without changing bindings, intake bookmarks or uncertain delivery records. Start only in bootstrap mode first.'
