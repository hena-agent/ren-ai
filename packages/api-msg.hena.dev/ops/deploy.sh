#!/bin/bash
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
[[ "${CONFIRM_STAGED_DEPLOYMENT:-}" == yes ]] || { echo 'Set CONFIRM_STAGED_DEPLOYMENT=yes only after reviewing maintenance mode and old intake status' >&2; exit 1; }
grep -qx 'BOOTSTRAP_ONLY=true' "${REN_AI_APP_ENV:?Set REN_AI_APP_ENV}" || { echo 'Deploy script only starts in bootstrap mode; resumption is an explicit cutover step' >&2; exit 1; }
docker compose -f "$ops/compose.yml" config --quiet
docker compose -f "$ops/compose.yml" build api-msg
docker compose -f "$ops/compose.yml" up -d api-msg cloudflared
echo 'Staged application only. Import/reconcile/verify before explicitly turning bootstrap mode off.'
