#!/bin/bash
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
artifact="${1:?Usage: install.sh ATTESTED-ARTIFACT-DIRECTORY PROTECTED-API-MSG.env}"
config="${2:?Usage: install.sh ATTESTED-ARTIFACT-DIRECTORY PROTECTED-API-MSG.env}"
root="${API_MSG_HOME:-$HOME/Library/Application Support/ren-ai-api-msg}"
[[ "$root" == /* && ! -e "$root" ]] || { echo 'A new absolute api-msg directory is required' >&2; exit 1; }
docker info > /dev/null
grep -q '^TOKEN_MANAGEMENT=.' "$config" && grep -q '^OPENCODE_AUTHORIZATION=.' "$config" && grep -q '^IMSG_TOKEN=.' "$config" || { echo 'TOKEN_MANAGEMENT, OPENCODE_AUTHORIZATION and IMSG_TOKEN are required' >&2; exit 1; }
if grep -qEv '^([[:space:]]*#.*|[[:space:]]*|TOKEN_MANAGEMENT=[^[:space:]]+|OPENCODE_URL=[^[:space:]]+|OPENCODE_AUTHORIZATION="Basic [^"]+"|IMSG_URL=[^[:space:]]+|IMSG_TOKEN=[^[:space:]]+)$' "$config"; then
  echo 'Unexpected api-msg environment setting; use only the documented executor variables' >&2
  exit 1
fi
bash "$ops/verify-artifact.sh" "$artifact"
umask 077
mkdir -p "$root"
cp "$artifact/api-msg.js" "$artifact/api-msg-verify.js" "$artifact/api-msg.graph.json" "$artifact/api-msg-verify.graph.json" "$artifact/artifact.info" "$artifact/SHA256SUMS" "$root/"
cp "$config" "$root/api-msg.env"
cp "$ops/Dockerfile" "$ops/Dockerfile.dockerignore" "$ops/compose.yml" "$root/"
chmod 700 "$root"
chmod 600 "$root/api-msg.env"
docker compose -f "$root/compose.yml" build api-msg
echo 'Built api-msg WITHOUT STARTING. Configure api-msg.renai.im -> http://api-msg:4700 on its Docker tunnel.'
