#!/bin/bash
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
root="${API_MSG_HOME:-$HOME/Library/Application Support/ren-ai-api-msg}"
binary="${1:?Usage: install-deploy-agent.sh REVIEWED-GH-BINARY PROTECTED-RAW-TOKEN-FILE}"
token="${2:?Supply a raw read-only GitHub token file}"
plist="${API_MSG_DEPLOY_LAUNCH_AGENT:-$HOME/Library/LaunchAgents/im.renai.api-msg-deploy.plist}"
[[ "$(uname -s)" == Darwin && -s "$root/compose.yml" && -x "$binary" && ! -e "$root/deploy" && ! -e "$plist" ]] || { echo 'Installed Docker api-msg and new deploy/plist destinations required' >&2; exit 1; }
docker info > /dev/null
docker_bin="$(dirname "$(command -v docker)")"
file -b "$binary" | grep -q 'Mach-O' || { echo 'Supply native gh, not a package-manager wrapper' >&2; exit 1; }
lipo "$binary" -verify_arch "$(uname -m)"
otool -L "$binary" | awk '/^[[:space:]]/ && $1 !~ /^\/(usr\/lib|System\/Library)\// {bad=1; print "Nonportable gh dependency: " $1 > "/dev/stderr"} END {exit bad}'
[[ "$(cat "$token")" =~ ^github_pat_[A-Za-z0-9_]+$ ]] || { echo 'One raw fine-grained GitHub token required' >&2; exit 1; }
umask 077
mkdir -p "$root/deploy/bin" "$root/deploy/logs" "$(dirname "$plist")"
cp "$binary" "$root/deploy/bin/gh"
cp "$token" "$root/deploy/token"
cp "$ops/update.sh" "$ops/../../imsg/ops/deploy-helper.sh" "$ops/verify-artifact.sh" "$root/deploy/"
chmod 700 "$root/deploy/bin/gh"
chmod 600 "$root/deploy/token"
bun -e '
const root = process.argv[1];
process.stdout.write(JSON.stringify({
  Label: "im.renai.api-msg-deploy",
  ProgramArguments: ["/bin/bash", root + "/deploy/update.sh", "api-msg", root],
  WorkingDirectory: root + "/deploy",
  EnvironmentVariables: { PATH: root + "/deploy/bin:" + process.argv[2] + ":/usr/bin:/bin:/usr/sbin:/sbin" },
  StandardOutPath: root + "/deploy/logs/stdout.log",
  StandardErrorPath: root + "/deploy/logs/stderr.log",
  RunAtLoad: true, StartInterval: 120,
}));
' "$root" "$docker_bin" | /usr/bin/plutil -convert xml1 -o "$plist" -
/usr/bin/plutil -lint "$plist"
echo 'api-msg deploy agent installed WITHOUT STARTING. It verifies main provenance and probes before replacing the executor.'
