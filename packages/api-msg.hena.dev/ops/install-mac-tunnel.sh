#!/bin/bash
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
root="${MESSAGING_HOME:-${IMSG_INSTALL_ROOT:-/usr/local/lib/ren-ai-messaging}}"
binary="${1:?Usage: install-mac-tunnel.sh REVIEWED-CLOUDFLARED-BINARY PROTECTED-RAW-TOKEN-FILE}"
token="${2:?Supply a raw Cloudflare Tunnel token file, not an env file}"
plist="${IMSG_TUNNEL_LAUNCH_AGENT:-$HOME/Library/LaunchAgents/dev.hena.ren-ai-imsg-tunnel.plist}"
[[ "$(uname -s)" == Darwin && "$root" == /* && "$plist" == /* && -s "$root/imsg.env" && -x "$binary" && ! -e "$root/tunnel" && ! -e "$plist" ]] || { echo 'Installed messaging gateway, executable cloudflared and new absolute tunnel/plist destinations required' >&2; exit 1; }
file -b "$binary" | grep -q 'Mach-O' || { echo 'Supply a native cloudflared binary, not a package-manager wrapper' >&2; exit 1; }
lipo "$binary" -verify_arch "$(uname -m)"
otool -L "$binary" | awk '/^[[:space:]]/ && $1 !~ /^\/(usr\/lib|System\/Library)\// {bad=1; print "Nonportable cloudflared dependency: " $1 > "/dev/stderr"} END {exit bad}'
[[ "$(cat "$token")" =~ ^[A-Za-z0-9+/_=-]+$ ]] || { echo 'One raw token required, not an env/config file' >&2; exit 1; }
umask 077
mkdir -p "$root/tunnel/bin" "$root/tunnel/logs" "$(dirname "$plist")"
cp "$binary" "$root/tunnel/bin/cloudflared"
cp "$token" "$root/tunnel/token"
chmod 700 "$root/tunnel/bin/cloudflared"
chmod 600 "$root/tunnel/token"
bash "$ops/write-tunnel-plist.sh" "$root/bin/bun" "$root/tunnel" "$plist"
/usr/bin/plutil -lint "$plist"
echo 'Messaging-only tunnel installed WITHOUT STARTING or changing ingress. Review imsg.hena.dev -> http://127.0.0.1:4702 before explicit GUI bootstrap.'
