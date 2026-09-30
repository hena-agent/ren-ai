#!/bin/bash
set -euo pipefail
bun="${1:?Supply the installed Bun executable}"
root="${2:?Supply the installed tunnel directory}"
target="${3:?Supply a new LaunchAgent plist path}"
[[ ! -e "$target" ]] || { echo 'Existing tunnel plist is never overwritten' >&2; exit 1; }
umask 077
"$bun" -e '
const root = process.argv[1];
process.stdout.write(JSON.stringify({
  Label: "dev.hena.ren-ai-imsg-tunnel",
  ProgramArguments: [root + "/bin/cloudflared", "tunnel", "--no-autoupdate", "run", "--token-file", root + "/token"],
  WorkingDirectory: root,
  StandardOutPath: root + "/logs/stdout.log",
  StandardErrorPath: root + "/logs/stderr.log",
  RunAtLoad: true, KeepAlive: true, ThrottleInterval: 10,
}));
' "$root" | /usr/bin/plutil -convert xml1 -o "$target" -
