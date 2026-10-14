#!/bin/bash
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$ops/../../.." && pwd)"
snapshot="${1:?Usage: export-legacy.sh SNAPSHOT-DIRECTORY OLD-PERSONA-DIRECTORY}"
directory="${2:?Supply the source session location, not the new /srv/ren-ai location}"
snapshot="$(cd "$snapshot" && pwd)"
[[ -s "$snapshot/opencode.sqlite" && ! -e "$snapshot/sessions.json" ]] || { echo 'Stopped snapshot and a new sessions.json are required' >&2; exit 1; }
docker build -f "$ops/Dockerfile" --target migration -t ren-ai/migration:local "$repo"
docker run --rm --network none --mount "type=bind,src=$snapshot,dst=/snapshot,readonly" --mount "type=bind,src=$snapshot,dst=/output" ren-ai/migration:local "$directory"
