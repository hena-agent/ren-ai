#!/bin/bash
set -euo pipefail
artifact="${1:?Usage: verify-artifact.sh ATTESTED-ARTIFACT-DIRECTORY}"
(
  cd "$artifact"
  grep -qx 'format=api-msg-v1' artifact.info
  for name in api-msg.js api-msg-verify.js api-msg.graph.json api-msg-verify.graph.json; do
    [[ -s "$name" ]] || { echo "Artifact lacks $name" >&2; exit 1; }
  done
  shasum -a 256 -c SHA256SUMS
)
if grep -Eiq '(@effect/sql|sqlite|better-sqlite3)' "$artifact"/*.graph.json; then
  echo 'Artifact dependency graph is not DB-free' >&2
  exit 1
fi
