#!/bin/bash
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$ops/../../.." && pwd)"
output="${1:?Usage: build-mac.sh NEW-ARTIFACT-DIRECTORY IMSG-BINARY}"
imsg="${2:?Supply the reviewed native imsg executable, not a Homebrew shell wrapper}"
resources="${3:-$(dirname "$imsg")}"
[[ "$(uname -s)" == Darwin && "$(bun --version)" == 1.4.2 ]] || { echo 'Build on macOS with Bun 1.4.2' >&2; exit 1; }
[[ -x "$imsg" && ! -e "$output" ]] || { echo 'Executable imsg and a new output directory are required' >&2; exit 1; }
file -b "$imsg" | grep -q 'Mach-O' || { echo 'Pass native libexec/imsg, not /opt/homebrew/bin/imsg or another wrapper' >&2; exit 1; }
[[ "$("$imsg" --version)" == 0.15.9 ]] || { echo 'The reviewed messaging adapter requires imsg 0.15.9' >&2; exit 1; }
for asset in imsg-bridge-helper.dylib PhoneNumberKit_PhoneNumberKit.bundle SQLite.swift_SQLite.bundle; do
  [[ -e "$resources/$asset" ]] || { echo "Missing native imsg resource: $asset" >&2; exit 1; }
done
for binary in "$imsg" "$(command -v bun)" "$resources/imsg-bridge-helper.dylib"; do
  lipo "$binary" -verify_arch "$(uname -m)"
done
otool -L "$imsg" "$(command -v bun)" "$resources/imsg-bridge-helper.dylib" | awk '/^[[:space:]]/ && $1 !~ /^\/(usr\/lib|System\/Library)\// && $1 != "@rpath/imsg-bridge-helper.dylib" {bad=1; print "Nonportable dylib: " $1 > "/dev/stderr"} END {exit bad}'
mkdir -p "$output/bin"
output="$(cd "$output" && pwd)"
chmod 700 "$output" "$output/bin"
bun build --target=bun --outfile="$output/imsg.js" --metafile="$output/imsg.graph.json" "$ops/imsg-entry.ts"
bun build --target=bun --outfile="$output/verify.js" --metafile="$output/verify.graph.json" "$ops/imsg-verify.ts"
bun "$ops/verify-mac-graph.ts" "$output/imsg.graph.json" "$output/verify.graph.json"
cp "$(command -v bun)" "$output/bin/bun"
cp "$imsg" "$output/bin/imsg"
cp -R "$resources/imsg-bridge-helper.dylib" "$resources/PhoneNumberKit_PhoneNumberKit.bundle" "$resources/SQLite.swift_SQLite.bundle" "$output/bin/"
cp "$repo/packages/api-msg.hena.dev/src/gestures/messages-ui.applescript" "$output/messages-ui.applescript"
cp "$ops/install.sh" "$output/install.sh"
cp "$ops/install-mac-tunnel.sh" "$ops/write-tunnel-plist.sh" "$ops/export-mac.sh" "$ops/restore-mac.sh" "$output/"
chmod 700 "$output/bin/bun" "$output/bin/imsg"
(
  cd "$output"
  printf 'architecture=%s\nbun=1.4.2\nimsg=0.15.9\n' "$(uname -m)" > artifact.info
  find . -type f ! -name SHA256SUMS -exec shasum -a 256 {} \; > SHA256SUMS
)
echo "Built $output. No OpenCode packages/credentials; installer does not start services."
