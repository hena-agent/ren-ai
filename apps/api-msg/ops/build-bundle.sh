#!/bin/bash
# Build portable JavaScript; the Docker image supplies the pinned Bun runtime.
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
output="${1:?Usage: build-bundle.sh NEW-OUTPUT-DIRECTORY}"
[[ "$(bun --version)" == 1.4.2 ]] || { echo 'Bundle with Bun 1.4.2' >&2; exit 1; }
[[ ! -e "$output" ]] || { echo 'Use a new output directory' >&2; exit 1; }
mkdir -p "$output"
bun build --target=bun --define "BUILD_REVISION=\"${GITHUB_SHA:-development}\"" --outfile="$output/api-msg.js" --metafile="$output/api-msg.graph.json" "$ops/api-msg-entry.mjs"
bun build --target=bun --define "BUILD_REVISION=\"${GITHUB_SHA:-development}\"" --outfile="$output/api-msg-verify.js" --metafile="$output/api-msg-verify.graph.json" "$ops/probe-entry.mjs"
if grep -Eiq '(@effect/sql|sqlite|better-sqlite3)' "$output"/*.graph.json; then
  echo 'The production api-msg artifact must not contain a SQL or SQLite dependency' >&2
  exit 1
fi
printf 'format=api-msg-v1\n' > "$output/artifact.info"
(cd "$output" && shasum -a 256 api-msg.js api-msg-verify.js api-msg.graph.json api-msg-verify.graph.json artifact.info > SHA256SUMS)
