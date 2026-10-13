#!/bin/bash
# Run by the dev.hena.ren-ai-imsg-deploy LaunchAgent: deploys the head of main once CI has
# built and attested its JavaScript payload. Binaries, credentials and permissions never change.
set -euo pipefail
root="${1:?Usage: update.sh INSTALLED-MESSAGING-HOME}"
deploy="$root/deploy"
repository=hena-agent/ren-ai
gateway="gui/$(id -u)/dev.hena.ren-ai-imsg"
payload=(imsg.js verify.js messages-ui.applescript imsg.graph.json verify.graph.json)
umask 077
GH_TOKEN="$(cat "$deploy/token")"
export GH_TOKEN GH_CONFIG_DIR="$deploy/gh" GH_PROMPT_DISABLED=1

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

latest="$(gh run list -R "$repository" -w ci.yml -b main -e push -L 1 --json databaseId,headSha,status --jq '.[] | "\(.databaseId) \(.headSha) \(.status)"')"
[[ -n "$latest" ]] || exit 0
read -r run sha status <<< "$latest"
[[ "$status" == completed ]] || exit 0
for known in deployed rejected; do
  [[ "$(cat "$deploy/$known" 2>/dev/null)" != "$sha" ]] || exit 0
done
# Only runs whose gates passed carry a bundle; a re-run that passes can still deploy.
[[ -n "$(gh api "repos/$repository/actions/runs/$run/artifacts" --jq '.artifacts[] | select(.name == "imsg-bundle" and (.expired | not)) | .id')" ]] || exit 0

staging="$(mktemp -d "$deploy/staging.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
gh run download "$run" -R "$repository" -n imsg-bundle -D "$staging"
gh attestation verify "$staging/imsg-bundle.tar.gz" -R "$repository" \
  --signer-workflow "github.com/$repository/.github/workflows/ci.yml" \
  --source-ref refs/heads/main --source-digest "$sha" --deny-self-hosted-runners > /dev/null
mkdir "$staging/bundle"
tar -xzf "$staging/imsg-bundle.tar.gz" -C "$staging/bundle"
for name in "${payload[@]}"; do
  [[ -f "$staging/bundle/$name" && -s "$staging/bundle/$name" ]] || { log "Bundle for $sha lacks $name"; exit 1; }
done

put() {
  local name
  for name in "${payload[@]}"; do
    cp "$1/$name" "$root/.$name.next"
    mv -f "$root/.$name.next" "$root/$name"
  done
}

# export-mac.sh archives the installation and restore verifies it against SHA256SUMS.
rehash() {
  {
    awk -v names="${payload[*]}" 'BEGIN { split(names, list, " "); for (i in list) skip["./" list[i]] = 1 } !($2 in skip)' "$root/SHA256SUMS"
    (cd "$root" && shasum -a 256 "${payload[@]/#/./}")
  } > "$root/.SHA256SUMS.next"
  mv -f "$root/.SHA256SUMS.next" "$root/SHA256SUMS"
}

probe() {
  local attempt output=""
  for ((attempt = 1; attempt <= ${DEPLOY_PROBE_ATTEMPTS:-10}; attempt++)); do
    if output="$("$root/bin/bun" --env-file="$root/imsg.env" "$root/verify.js" 2>&1)"; then return 0; fi
    sleep "${DEPLOY_PROBE_DELAY:-3}"
  done
  log "Probe failed: $(printf '%s' "$output" | tail -c 400)"
  return 1
}

rm -rf "$deploy/previous"
mkdir "$deploy/previous"
for name in "${payload[@]}" SHA256SUMS; do cp -p "$root/$name" "$deploy/previous/$name"; done
log "Deploying $sha"
put "$staging/bundle"
rehash
launchctl kickstart -k "$gateway"
if probe; then
  printf '%s\n' "$sha" > "$deploy/deployed"
  log "Deployed $sha"
  exit 0
fi
put "$deploy/previous"
cp -p "$deploy/previous/SHA256SUMS" "$root/SHA256SUMS"
launchctl kickstart -k "$gateway"
if probe; then
  printf '%s\n' "$sha" > "$deploy/rejected"
  log "Rolled back $sha: its gateway failed the probe; waiting for a newer commit"
else
  log "Rolled back $sha, but the previous gateway fails the probe too; retrying next run"
fi
exit 1
