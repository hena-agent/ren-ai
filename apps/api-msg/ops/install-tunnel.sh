#!/bin/bash
set -euo pipefail
root="${API_MSG_HOME:-/usr/local/lib/ren-ai-api-msg}"
binary="${1:?Usage: install-tunnel.sh REVIEWED-CLOUDFLARED-BINARY PROTECTED-RAW-TOKEN-FILE}"
token="${2:?Supply the api-msg.renai.im tunnel token file}"
plist="${API_MSG_TUNNEL_LAUNCH_AGENT:-$HOME/Library/LaunchAgents/im.renai.api-msg-tunnel.plist}"
[[ "$(uname -s)" == Darwin && "$root" == /* && -x "$root/bin/bun" && -x "$binary" && -s "$root/api-msg.env" && ! -e "$root/tunnel" && ! -e "$plist" ]] || { echo 'Installed api-msg and new absolute tunnel/plist destinations required' >&2; exit 1; }
file -b "$binary" | grep -q 'Mach-O' || { echo 'Supply native cloudflared, not a wrapper' >&2; exit 1; }
lipo "$binary" -verify_arch "$(uname -m)"
otool -L "$binary" | awk '/^[[:space:]]/ && $1 !~ /^\/(usr\/lib|System\/Library)\// {bad=1; print "Nonportable cloudflared dependency: " $1 > "/dev/stderr"} END {exit bad}'
[[ "$(cat "$token")" =~ ^[A-Za-z0-9+/_=-]+$ ]] || { echo 'One raw tunnel token required' >&2; exit 1; }
umask 077
mkdir -p "$root/tunnel/bin" "$root/tunnel/logs" "$(dirname "$plist")"
cp "$binary" "$root/tunnel/bin/cloudflared"
cp "$token" "$root/tunnel/token"
chmod 700 "$root/tunnel/bin/cloudflared"
chmod 600 "$root/tunnel/token"
"$root/bin/bun" -e '
const root = process.argv[1];
process.stdout.write(JSON.stringify({
  Label: "im.renai.api-msg-tunnel",
  ProgramArguments: [root + "/tunnel/bin/cloudflared", "tunnel", "--no-autoupdate", "--token-file", root + "/tunnel/token"],
  WorkingDirectory: root + "/tunnel",
  EnvironmentVariables: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  StandardOutPath: root + "/tunnel/logs/stdout.log",
  StandardErrorPath: root + "/tunnel/logs/stderr.log",
  RunAtLoad: true, KeepAlive: true,
}));
' "$root" | /usr/bin/plutil -convert xml1 -o "$plist" -
/usr/bin/plutil -lint "$plist"
echo 'api-msg tunnel installed WITHOUT STARTING. Configure api-msg.renai.im -> http://127.0.0.1:4700; imsg and OC ingress are unchanged.'
