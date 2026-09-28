#!/bin/bash
set -euo pipefail
logs="${XDG_STATE_HOME:-/Users/chris/.local/state/ren-ai}/logs"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
for name in stdout stderr web-ui-stdout web-ui-stderr; do
  if [[ -s "$logs/$name.log" ]]; then
    cp "$logs/$name.log" "$logs/$name.$stamp.log"
    : > "$logs/$name.log"
  fi
done
find "$logs" -type f \( -name 'stdout.*.log' -o -name 'stderr.*.log' -o -name 'web-ui-stdout.*.log' -o -name 'web-ui-stderr.*.log' \) -mtime +13 -delete
