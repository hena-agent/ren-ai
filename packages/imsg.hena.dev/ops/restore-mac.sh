#!/bin/bash
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
backup="${1:?Usage: restore-mac.sh BACKUP-DIRECTORY NEW-STAGING-DIRECTORY}"
staging="${2:?Use a new staging directory}"
plist="${IMSG_TUNNEL_LAUNCH_AGENT:-$HOME/Library/LaunchAgents/dev.hena.ren-ai-imsg-tunnel.plist}"
deploy_plist="${IMSG_DEPLOY_LAUNCH_AGENT:-$HOME/Library/LaunchAgents/dev.hena.ren-ai-imsg-deploy.plist}"
[[ ! -e "$staging" && ! -e "$plist" && ! -e "$deploy_plist" ]] || { echo 'Use new staging, tunnel and deploy plist destinations' >&2; exit 1; }
(
  cd "$backup"
  shasum -a 256 -c SHA256SUMS
)
umask 077
mkdir -p "$staging"
tar -xpf "$backup/imsg-installation.tar" -C "$staging"
bash "$ops/install.sh" "$staging" "$staging/imsg.env"
# Gateway install copies the tunnel and deploy agent too, but the destination paths differ:
# generate their new plists without changing preserved tokens/binaries.
root="${MESSAGING_HOME:-${IMSG_INSTALL_ROOT:-/usr/local/lib/ren-ai-messaging}}"
bash "$ops/write-tunnel-plist.sh" "$root/bin/bun" "$root/tunnel" "$plist"
/usr/bin/plutil -lint "$plist"
if [[ -e "$root/deploy" ]]; then
  bash "$ops/write-deploy-plist.sh" "$root/bin/bun" "$root" "$deploy_plist"
  /usr/bin/plutil -lint "$deploy_plist"
fi
echo 'Restored WITHOUT STARTING. Complete Apple sign-in, history sync, Fleet enrollment/PPPC verification before switching imsg.hena.dev.'
