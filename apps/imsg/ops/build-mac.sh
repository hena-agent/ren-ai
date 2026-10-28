#!/bin/bash
set -euo pipefail
ops="$(cd "$(dirname "$0")" && pwd)"
output="${1:?Usage: build-mac.sh NEW-ARTIFACT-DIRECTORY RUSTPUSH-BINARY}"
native="${2:?Supply the ren-rustpush executable built from this checkout}"
[[ "$(uname -s)" == Darwin && "$(bun --version)" == 1.4.4 ]] || { echo 'Build on macOS with Bun 1.4.4' >&2; exit 1; }
[[ -x "$native" && ! -e "$output" ]] || { echo 'Executable ren-rustpush and a new output directory are required' >&2; exit 1; }
file -b "$native" | grep -q 'Mach-O' || { echo 'Pass the native ren-rustpush executable' >&2; exit 1; }
for binary in "$native" "$(command -v bun)"; do
  lipo "$binary" -verify_arch "$(uname -m)"
done
otool -L "$native" "$(command -v bun)" | awk '/^[[:space:]]/ && $1 !~ /^\/(usr\/lib|System\/Library)\// {bad=1; print "Nonportable dylib: " $1 > "/dev/stderr"} END {exit bad}'
bash "$ops/build-bundle.sh" "$output"
mkdir -p "$output/bin"
output="$(cd "$output" && pwd)"
chmod 700 "$output" "$output/bin"
cp "$(command -v bun)" "$output/bin/bun"
cp "$native" "$output/ren-rustpush"
cp "$ops/install.sh" "$output/install.sh"
cp "$ops/install-mac-tunnel.sh" "$ops/write-tunnel-plist.sh" "$ops/export-mac.sh" "$ops/restore-mac.sh" "$output/"
cp "$ops/install-deploy-agent.sh" "$ops/write-deploy-plist.sh" "$ops/update.sh" "$ops/deploy-helper.sh" "$output/"
chmod 700 "$output/bin/bun" "$output/ren-rustpush"
(
  cd "$output"
  printf 'architecture=%s\nbun=1.4.4\ntransport=rustpush\n' "$(uname -m)" > artifact.info
  find . -type f ! -name SHA256SUMS -exec shasum -a 256 {} \; > SHA256SUMS
)
echo "Built $output. No OpenCode packages/credentials; installer does not start services."
