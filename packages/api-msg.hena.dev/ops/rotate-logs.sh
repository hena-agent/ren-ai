#!/bin/bash
set -euo pipefail
logs="${XDG_STATE_HOME:-/Users/chris/.local/state/ren-ai}/logs"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
for name in stdout stderr; do
  if [[ -s "$logs/$name.log" ]]; then
    cp "$logs/$name.log" "$logs/$name.$stamp.log"
    : > "$logs/$name.log"
  fi
done
find "$logs" -type f \( -name 'stdout.*.log' -o -name 'stderr.*.log' \) -mtime +13 -delete
