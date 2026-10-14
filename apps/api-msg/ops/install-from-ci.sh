#!/bin/bash
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
repository=hena-agent/ren-ai
config="${1:?Usage: install-from-ci.sh PROTECTED-API-MSG.env}"
latest="$(gh run list -R "$repository" -w ci.yml -b main -e push -L 1 --json databaseId,headSha,status --jq '.[] | "\(.databaseId) \(.headSha) \(.status)"')"
[[ -n "$latest" ]] || { echo 'No main CI run is available' >&2; exit 1; }
read -r run sha status <<< "$latest"
[[ "$status" == completed ]] || { echo 'Latest main CI run is not complete' >&2; exit 1; }
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
gh run download "$run" -R "$repository" -n api-msg-bundle -D "$stage"
gh attestation verify "$stage/api-msg-bundle.tar.gz" -R "$repository" \
  --signer-workflow "github.com/$repository/.github/workflows/ci.yml" \
  --source-ref refs/heads/main --source-digest "$sha" --deny-self-hosted-runners > /dev/null
mkdir "$stage/bundle"
tar -xzf "$stage/api-msg-bundle.tar.gz" -C "$stage/bundle"
bash "$ops/install.sh" "$stage/bundle" "$config"
