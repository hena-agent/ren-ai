#!/bin/bash
set -euo pipefail
root="${MESSAGING_HOME:-${IMSG_INSTALL_ROOT:-/usr/local/lib/ren-ai-messaging}}"
output="${1:?Usage: export-mac.sh NEW-PRIVATE-BACKUP-DIRECTORY}"
[[ -s "$root/tunnel/token" ]] || { echo 'Install the separate messaging tunnel first so its credentials survive relocation' >&2; exit 1; }
[[ ! -e "$output" && -s "$root/imsg.env" ]] || { echo 'Installed Mac service and a new backup directory are required' >&2; exit 1; }
if launchctl print "gui/$(id -u)/im.renai.imsg-deploy" >/dev/null 2>&1; then
  echo 'Boot out the deploy agent before export so it cannot replace files mid-archive' >&2
  exit 1
fi
if launchctl print "gui/$(id -u)/im.renai.imsg" >/dev/null 2>&1; then
  echo 'Boot out the Mac service before export; this script does not stop live services' >&2
  exit 1
fi
if launchctl print "gui/$(id -u)/im.renai.imsg-tunnel" >/dev/null 2>&1; then
  echo 'Boot out the messaging tunnel before export; existing tunnels are never stopped automatically' >&2
  exit 1
fi
umask 077
mkdir -p "$output"
output="$(cd "$output" && pwd)"
tar -cpf "$output/imsg-installation.tar" -C "$root" .
(
  cd "$output"
  shasum -a 256 imsg-installation.tar > SHA256SUMS
)
echo 'Mac artifact, Apple session, durable history, attachment spool, tokens and logs exported privately; no OpenCode credentials included.'
