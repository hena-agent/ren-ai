#!/bin/bash
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
state="$HOME/.local/state/ren-ai"
mkdir -p "$state/logs" "$state/operator" "$HOME/.config/ren-ai" "$HOME/.local/share/ren-ai" "$HOME/.cache/ren-ai"
chmod 700 "$state" "$state/logs" "$state/operator" "$HOME/.config/ren-ai" "$HOME/.local/share/ren-ai" "$HOME/.cache/ren-ai"
mkdir -p "$state/web-ui"/{home,config,data,cache,state}
chmod 700 "$state/web-ui" "$state/web-ui"/{home,config,data,cache,state}
mkdir -p "$HOME/Library/LaunchAgents"
for name in dev.hena.ren-ai dev.hena.ren-ai-logs dev.hena.ren-ai-web-ui; do
  target="$HOME/Library/LaunchAgents/$name.plist"
  if [[ -e "$target" ]] && ! cmp -s "$ops/$name.plist" "$target"; then
    echo "Existing $target differs; inspect it manually before replacing" >&2
    exit 1
  fi
done
"$ops/install-web-ui.sh"
for name in dev.hena.ren-ai dev.hena.ren-ai-logs dev.hena.ren-ai-web-ui; do
  target="$HOME/Library/LaunchAgents/$name.plist"
  [[ -e "$target" ]] || cp "$ops/$name.plist" "$target"
done
echo 'Installed (not loaded). With someone at the Mac, run:'
echo "  launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/dev.hena.ren-ai-web-ui.plist"
echo "  launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/dev.hena.ren-ai.plist"
echo "  launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/dev.hena.ren-ai-logs.plist"
