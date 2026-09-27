#!/bin/bash
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
state="$HOME/.local/state/ren-ai"
mkdir -p "$state/logs" "$state/operator" "$HOME/.config/ren-ai" "$HOME/.local/share/ren-ai" "$HOME/.cache/ren-ai"
chmod 700 "$state" "$state/logs" "$state/operator" "$HOME/.config/ren-ai" "$HOME/.local/share/ren-ai" "$HOME/.cache/ren-ai"
mkdir -p "$HOME/Library/LaunchAgents"
cp "$ops/dev.hena.ren-ai.plist" "$ops/dev.hena.ren-ai-logs.plist" "$HOME/Library/LaunchAgents/"
echo 'Installed (not loaded). With someone at the Mac, run:'
echo '  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.hena.ren-ai.plist'
echo '  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.hena.ren-ai-logs.plist'
