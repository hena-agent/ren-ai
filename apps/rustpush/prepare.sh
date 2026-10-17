#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
patch="$PWD/native.patch"
sources="$PWD/../../node_modules/.cache/ren-rustpush"

checkout() {
  local name="$1" url="$2" revision="$3"
  if [[ ! -d "$sources/$name" ]]; then
    git clone "$url" "$sources/$name"
    git -C "$sources/$name" checkout --detach "$revision"
  fi
  [[ "$(git -C "$sources/$name" rev-parse HEAD)" == "$revision" ]] || {
    echo "Unexpected $name revision; inspect $sources/$name before proceeding." >&2
    exit 1
  }
}

mkdir -p "$sources"
checkout rustpush https://github.com/OpenBubbles/rustpush.git b3c96c23e1aae78d1229ebaccb12027624f1eaff
checkout matrix https://github.com/jasonlaguidice/imessage.git 595ce7e9bb588fbcf7cbe9906a0b79b7b0869c41
git -C "$sources/rustpush" -c url.https://github.com/.insteadOf=git@github.com: submodule update --init --recursive
if ! git -C "$sources/rustpush" apply --unidiff-zero --reverse --check "$patch" 2>/dev/null; then
  git -C "$sources/rustpush" apply --unidiff-zero --check "$patch"
  git -C "$sources/rustpush" apply --unidiff-zero "$patch"
fi
