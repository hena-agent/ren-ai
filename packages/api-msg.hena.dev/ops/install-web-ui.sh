#!/bin/bash
set -euo pipefail

bin="$HOME/.local/share/ren-ai/web-ui/bin"
binary="$bin/opencode-2.0.16"
if [[ -e "$binary" ]]; then
  [[ "$("$binary" --version)" == 'opencode v2.0.16' ]] || {
    echo "Existing $binary is not OpenCode 2.0.16; refusing to replace it" >&2
    exit 1
  }
  exit 0
fi

mkdir -p "$bin"
chmod 700 "$HOME/.local/share/ren-ai" "$HOME/.local/share/ren-ai/web-ui" "$bin"
temp="$(mktemp -d "$bin/.install.XXXXXX")"
trap 'rm -rf "$temp"' EXIT
/usr/bin/curl --fail --location --silent --show-error \
  https://opencode.ai/files/bin/2.0.16/opencode-darwin-arm64.zip -o "$temp/opencode.zip"
printf '%s  %s\n' '15591ea3b9920e018d2d8016067c69b71e1756c869586c7eae87eb110d952bd5' "$temp/opencode.zip" \
  | /usr/bin/shasum -a 256 -c -
/usr/bin/unzip -oq "$temp/opencode.zip" opencode -d "$temp"
chmod 700 "$temp/opencode"
[[ "$("$temp/opencode" --version)" == 'opencode v2.0.16' ]]
mv "$temp/opencode" "$binary"
echo "Installed $binary (not started)"
