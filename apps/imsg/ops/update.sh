#!/bin/bash
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
root="${1:?Usage: update.sh INSTALLED-MESSAGING-HOME}"
exec /bin/bash "$ops/deploy-helper.sh" imsg "$root"
