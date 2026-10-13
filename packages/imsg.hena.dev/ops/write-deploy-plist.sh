#!/bin/bash
set -euo pipefail
bun="${1:?Supply the installed Bun executable}"
root="${2:?Supply the installed messaging home}"
target="${3:?Supply a new LaunchAgent plist path}"
[[ ! -e "$target" ]] || { echo 'Existing deploy plist is never overwritten' >&2; exit 1; }
umask 077
"$bun" -e '
const root = process.argv[1];
process.stdout.write(JSON.stringify({
  Label: "dev.hena.ren-ai-imsg-deploy",
  ProgramArguments: ["/bin/bash", root + "/deploy/update.sh", root],
  WorkingDirectory: root + "/deploy",
  EnvironmentVariables: { PATH: root + "/deploy/bin:" + root + "/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
  StandardOutPath: root + "/deploy/logs/stdout.log",
  StandardErrorPath: root + "/deploy/logs/stderr.log",
  RunAtLoad: true, StartInterval: 120,
}));
' "$root" | /usr/bin/plutil -convert xml1 -o "$target" -
