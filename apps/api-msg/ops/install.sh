#!/bin/bash
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
artifact="${1:?Usage: install.sh ATTESTED-ARTIFACT-DIRECTORY PROTECTED-API-MSG.env}"
config="${2:?Usage: install.sh ATTESTED-ARTIFACT-DIRECTORY PROTECTED-API-MSG.env}"
root="${API_MSG_HOME:-/usr/local/lib/ren-ai-api-msg}"
bun="${IMSG_HOME:-/usr/local/lib/ren-ai-messaging}/bin/bun"
plist="${API_MSG_LAUNCH_AGENT:-$HOME/Library/LaunchAgents/im.renai.api-msg.plist}"
[[ "$(uname -s)" == Darwin && "$(id -u)" != 0 ]] || { echo 'macOS GUI user required; do not run as root' >&2; exit 1; }
[[ "$root" == /* && "$bun" == /* && "$plist" == /* && -x "$bun" && ! -e "$root" && ! -e "$plist" ]] || { echo 'New absolute api-msg paths and the installed imsg Bun runtime are required' >&2; exit 1; }
grep -q '^TOKEN_MANAGEMENT=.' "$config" && grep -q '^OPENCODE_AUTHORIZATION=.' "$config" && grep -q '^IMSG_TOKEN=.' "$config" || { echo 'TOKEN_MANAGEMENT, OPENCODE_AUTHORIZATION and IMSG_TOKEN are required' >&2; exit 1; }
if grep -qEv '^([[:space:]]*#.*|[[:space:]]*|TOKEN_MANAGEMENT=[^[:space:]]+|TOKEN_CATALOG=[^[:space:]]+|OPENCODE_URL=[^[:space:]]+|OPENCODE_AUTHORIZATION="Basic [^"]+"|IMSG_URL=[^[:space:]]+|IMSG_TOKEN=[^[:space:]]+|LISTEN_HOST=[^[:space:]]+|PORT=[0-9]+)$' "$config"; then
  echo 'Unexpected api-msg environment setting; use only the documented executor variables' >&2
  exit 1
fi
(
  bash "$ops/verify-artifact.sh" "$artifact"
)
umask 077
mkdir -p "$root/bin" "$root/logs" "$(dirname "$plist")"
ln -s "$bun" "$root/bin/bun"
cp "$artifact/api-msg.js" "$artifact/api-msg-verify.js" "$artifact/api-msg.graph.json" "$artifact/api-msg-verify.graph.json" "$artifact/artifact.info" "$artifact/SHA256SUMS" "$root/"
cp "$config" "$root/api-msg.env"
chmod 700 "$root" "$root/bin" "$root/logs"
chmod 600 "$root/api-msg.env"
"$bun" -e '
const root = process.argv[1];
process.stdout.write(JSON.stringify({
  Label: "im.renai.api-msg",
  ProgramArguments: [root + "/bin/bun", "--env-file=" + root + "/api-msg.env", root + "/api-msg.js"],
  WorkingDirectory: root,
  EnvironmentVariables: { PATH: root + "/bin:/usr/bin:/bin" },
  StandardOutPath: root + "/logs/stdout.log",
  StandardErrorPath: root + "/logs/stderr.log",
  RunAtLoad: true, KeepAlive: true, ThrottleInterval: 10,
}));
' "$root" | /usr/bin/plutil -convert xml1 -o "$plist" -
/usr/bin/plutil -lint "$plist"
echo 'Installed api-msg WITHOUT STARTING. Review api-msg.renai.im -> http://127.0.0.1:4700 before provisioning its tunnel.'
