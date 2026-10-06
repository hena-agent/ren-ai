#!/bin/bash
set -euo pipefail
artifact="${1:-$(cd "$(dirname "$0")" && pwd)}"
root="${MESSAGING_HOME:-${IMSG_INSTALL_ROOT:-/usr/local/lib/ren-ai-messaging}}"
config="${2:?Usage: install.sh ARTIFACT-DIRECTORY IMSG-ONLY.env}"
plist="${IMSG_LAUNCH_AGENT:-$HOME/Library/LaunchAgents/dev.hena.ren-ai-imsg.plist}"
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS GUI user required' >&2; exit 1; }
[[ "$(id -u)" != 0 ]] || { echo 'Run as the intended GUI user, not root; the installer requests sudo only for its new identity directory if necessary' >&2; exit 1; }
[[ "$root" == /* && "$plist" == /* && ! -e "$root" && ! -e "$plist" ]] || { echo 'Use new absolute install/plist paths; existing installations are never overwritten' >&2; exit 1; }
grep -q '^IMSG_TOKEN=.' "$config" || { echo 'IMSG_TOKEN is required' >&2; exit 1; }
if grep -qEv '^([[:space:]]*#.*|[[:space:]]*|IMSG_(TOKEN|PORT|LISTEN_HOST)=[^[:space:]]+)$' "$config"; then
  echo 'Mac configuration accepts only IMSG_TOKEN, IMSG_PORT, IMSG_LISTEN_HOST (unquoted values)' >&2
  exit 1
fi
(
  cd "$artifact"
  shasum -a 256 -c SHA256SUMS
  grep -qx "architecture=$(uname -m)" artifact.info
)
umask 077
if ! mkdir -p "$root"; then
  sudo /bin/sh -c 'umask 022; mkdir -p "$1"; mkdir -m 700 "$2"; chown "$3" "$2"' sh "$(dirname "$root")" "$root" "$(id -u):$(id -g)"
fi
mkdir -p "$(dirname "$plist")"
cp -R "$artifact/" "$root/"
cp "$config" "$root/imsg.env"
mkdir -p "$root/logs"
chmod 700 "$root" "$root/bin" "$root/logs"
chmod 600 "$root/imsg.env"
"$root/bin/bun" -e '
const root = process.argv[1];
process.stdout.write(JSON.stringify({
  Label: "dev.hena.ren-ai-imsg",
  ProgramArguments: [root + "/bin/bun", "--env-file=" + root + "/imsg.env", root + "/imsg.js"],
  WorkingDirectory: root,
  EnvironmentVariables: { PATH: root + "/bin:/usr/bin:/bin" },
  StandardOutPath: root + "/logs/stdout.log",
  StandardErrorPath: root + "/logs/stderr.log",
  RunAtLoad: true, KeepAlive: true, ThrottleInterval: 10,
}));
' "$root" | /usr/bin/plutil -convert xml1 -o "$plist" -
/usr/bin/plutil -lint "$plist"
echo "Installed WITHOUT STARTING. Stable permission identities: $root/bin/bun and $root/bin/imsg"
echo 'Enroll in Fleet, deliver profiles, retire old intake at the approved cutover, then explicitly bootstrap this GUI LaunchAgent.'
