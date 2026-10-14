#!/bin/bash
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
root="${MESSAGING_HOME:-${IMSG_INSTALL_ROOT:-/usr/local/lib/ren-ai-messaging}}"
binary="${1:?Usage: install-deploy-agent.sh REVIEWED-GH-BINARY PROTECTED-RAW-TOKEN-FILE}"
token="${2:?Supply a raw read-only GitHub token file, not an env file}"
plist="${IMSG_DEPLOY_LAUNCH_AGENT:-$HOME/Library/LaunchAgents/im.renai.imsg-deploy.plist}"
[[ "$(uname -s)" == Darwin && "$root" == /* && "$plist" == /* && -s "$root/imsg.env" && -x "$binary" && ! -e "$root/deploy" && ! -e "$plist" ]] || { echo 'Installed messaging gateway, executable gh and new absolute deploy/plist destinations required' >&2; exit 1; }
file -b "$binary" | grep -q 'Mach-O' || { echo 'Supply the native gh binary, not a package-manager wrapper' >&2; exit 1; }
lipo "$binary" -verify_arch "$(uname -m)"
otool -L "$binary" | awk '/^[[:space:]]/ && $1 !~ /^\/(usr\/lib|System\/Library)\// {bad=1; print "Nonportable gh dependency: " $1 > "/dev/stderr"} END {exit bad}'
[[ "$(cat "$token")" =~ ^github_pat_[A-Za-z0-9_]+$ ]] || { echo 'One raw fine-grained GitHub token required' >&2; exit 1; }
umask 077
mkdir -p "$root/deploy/bin" "$root/deploy/logs" "$(dirname "$plist")"
cp "$binary" "$root/deploy/bin/gh"
cp "$token" "$root/deploy/token"
cp "$ops/update.sh" "$root/deploy/update.sh"
cp "$ops/deploy-helper.sh" "$root/deploy/deploy-helper.sh"
cp "$ops/../../api-msg/ops/verify-artifact.sh" "$root/deploy/verify-artifact.sh"
chmod 700 "$root/deploy/bin/gh"
chmod 600 "$root/deploy/token"
bash "$ops/write-deploy-plist.sh" "$root/bin/bun" "$root" "$plist"
/usr/bin/plutil -lint "$plist"
echo 'Deploy agent installed WITHOUT STARTING. Bootstrap it once the gateway probe passes; it deploys the head of main every two minutes when CI attested its bundle.'
