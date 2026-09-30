#!/bin/bash
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
backup="${1:?Usage: restore-mac.sh BACKUP-DIRECTORY NEW-STAGING-DIRECTORY}"
staging="${2:?Use a new staging directory}"
plist="${IMSG_TUNNEL_LAUNCH_AGENT:-$HOME/Library/LaunchAgents/dev.hena.ren-ai-imsg-tunnel.plist}"
[[ ! -e "$staging" && ! -e "$plist" ]] || { echo 'Use new staging and tunnel plist destinations' >&2; exit 1; }
(
  cd "$backup"
  shasum -a 256 -c SHA256SUMS
)
umask 077
mkdir -p "$staging"
tar -xpf "$backup/imsg-installation.tar" -C "$staging"
bash "$ops/install.sh" "$staging" "$staging/imsg.env"
# Gateway install copies the tunnel artifact too, but the destination paths differ:
# generate its new plist without changing its preserved token/binary.
root="${MESSAGING_HOME:-${IMSG_INSTALL_ROOT:-/usr/local/lib/ren-ai-messaging}}"
bash "$ops/write-tunnel-plist.sh" "$root/bin/bun" "$root/tunnel" "$plist"
/usr/bin/plutil -lint "$plist"
echo 'Restored WITHOUT STARTING. Complete Apple sign-in, history sync, Fleet enrollment/PPPC verification before switching imsg.hena.dev.'
