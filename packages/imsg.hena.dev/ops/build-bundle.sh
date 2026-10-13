#!/bin/bash
# The JavaScript payload that runs on the installed Bun: what CI deploys automatically.
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
output="${1:?Usage: build-bundle.sh NEW-OUTPUT-DIRECTORY}"
[[ "$(bun --version)" == 1.4.2 ]] || { echo 'Bundle with Bun 1.4.2, the runtime installed on the Mac' >&2; exit 1; }
[[ ! -e "$output" ]] || { echo 'Use a new output directory' >&2; exit 1; }
mkdir -p "$output"
bun build --target=bun --outfile="$output/imsg.js" --metafile="$output/imsg.graph.json" "$ops/imsg-entry.ts"
bun build --target=bun --outfile="$output/verify.js" --metafile="$output/verify.graph.json" "$ops/imsg-verify.ts"
bun "$ops/verify-mac-graph.ts" "$output/imsg.graph.json" "$output/verify.graph.json"
cp "$ops/../src/gestures/messages-ui.applescript" "$output/messages-ui.applescript"
