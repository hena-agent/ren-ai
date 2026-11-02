#!/bin/bash
set -euo pipefail
root="${1:?Usage: install-social.sh INSTALLED-API-MSG-HOME}"
plist="${SOCIAL_LAUNCH_AGENT:-$HOME/Library/LaunchAgents/im.renai.social.plist}"
[[ "$(uname -s)" == Darwin && "$(id -u)" != 0 && "$root" == /* && "$plist" == /* && -s "$root/social.js" && -s "$root/api-msg.env" && ! -e "$plist" ]] || { echo 'Installed api-msg payload, GUI user and a new absolute social LaunchAgent path required' >&2; exit 1; }
[[ "$(bun --version)" == 1.4.4 ]] || { echo 'Install with native Bun 1.4.4' >&2; exit 1; }
umask 077
mkdir -p "$root/bin" "$root/browser" "$root/social-state" "$root/social-logs" "$(dirname "$plist")"
cp "$(command -v bun)" "$root/bin/bun"
bun add --cwd "$root/browser" --ignore-scripts --exact agent-browser@0.41.0
case "$(uname -m)" in arm64) arch=arm64;; x86_64) arch=x64;; *) exit 1;; esac
cp "$root/browser/node_modules/agent-browser/bin/agent-browser-darwin-$arch" "$root/bin/agent-browser"
chmod 700 "$root/bin" "$root/bin/bun" "$root/bin/agent-browser" "$root/social-state" "$root/social-logs"
"$root/bin/agent-browser" --version | grep -qx 'agent-browser 0.41.0'
"$root/bin/bun" -e '
const root = process.argv[1];
process.stdout.write(JSON.stringify({
  Label: "im.renai.social",
  ProgramArguments: [root + "/bin/bun", "--env-file=" + root + "/api-msg.env", root + "/social.js"],
  WorkingDirectory: root,
  EnvironmentVariables: {
    PATH: root + "/bin:/usr/bin:/bin",
    SOCIAL_HOME: root + "/social-state",
    SOCIAL_AGENT_BROWSER: root + "/bin/agent-browser",
  },
  StandardOutPath: root + "/social-logs/stdout.log",
  StandardErrorPath: root + "/social-logs/stderr.log",
  RunAtLoad: true, KeepAlive: true, ThrottleInterval: 10,
}));
' "$root" | plutil -convert xml1 -o "$plist" -
plutil -lint "$plist"
echo 'Installed native social executor WITHOUT STARTING. Install Google Chrome Canary, then bootstrap im.renai.social in this GUI session before starting api-msg.'
