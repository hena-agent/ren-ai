#!/bin/bash
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
profile="${1:?Usage: update.sh api-msg INSTALLED-API-MSG-HOME}"
root="${2:?Usage: update.sh api-msg INSTALLED-API-MSG-HOME}"
[[ "$profile" == api-msg ]] || { echo 'Unknown api-msg deploy profile' >&2; exit 2; }
exec /bin/bash "$ops/deploy-helper.sh" "$profile" "$root"
