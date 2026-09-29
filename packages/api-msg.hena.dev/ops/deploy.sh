#!/bin/bash
set -euo pipefail
host="${1:-chris-mini}"
ssh "$host" 'set -e; cd /Users/chris/git/hena-agent/ren-ai; git fetch origin main; git merge --ff-only origin/main; /Users/chris/.bun/bin/bun install --frozen-lockfile; launchctl kickstart -k gui/$(id -u)/dev.hena.ren-ai-web-ui; launchctl kickstart -k gui/$(id -u)/dev.hena.ren-ai'
