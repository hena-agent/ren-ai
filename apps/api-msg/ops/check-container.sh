#!/bin/bash
# Exercise the published bundle with the production filesystem restrictions.
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
bundle="${1:?Usage: check-container.sh BUNDLE-DIRECTORY}"
image="ren-ai/api-msg-probe:$(date +%s)-$$"
trap 'docker image rm "$image" >/dev/null' EXIT
docker build -f "$ops/Dockerfile" -t "$image" "$bundle"
docker run --rm --network none --read-only --tmpfs /tmp \
  --env TOKEN_MANAGEMENT=isolated --env OPENCODE_AUTHORIZATION=isolated \
  --env IMSG_TOKEN=isolated --env PORT=0 --entrypoint /bin/sh "$image" -c '
    # Port zero is allocated by the OS; read the actual address from the listener event.
    bun /app/api-msg.js > /tmp/listener.log 2>&1 &
    server=$!
    trap "kill $server 2>/dev/null || true" EXIT
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$server" 2>/dev/null || { cat /tmp/listener.log; exit 1; }
      if port="$(bun -e '\''const line = (await Bun.file("/tmp/listener.log").text()).split("\n")[0]; console.log(new URL(JSON.parse(line).url).port)'\'' 2>/dev/null)" &&
        PORT="$port" bun /app/api-msg-verify.js; then exit 0; fi
      sleep 1
    done
    cat /tmp/listener.log
    exit 1
  '
