#!/bin/bash
# Run by the im.renai.imsg-deploy LaunchAgent: deploys the head of main once CI has
# built and attested its JavaScript payload. Binaries, credentials and permissions never change.
set -euo pipefail
root="${1:?Usage: update.sh INSTALLED-MESSAGING-HOME}"
deploy="$root/deploy"
repository=hena-agent/ren-ai
gateway="gui/$(id -u)/im.renai.imsg"
payload=(imsg.js verify.js messages-ui.applescript imsg.graph.json verify.graph.json)
# Only these change what runs; the dependency graphs are build metadata.
runtime=(imsg.js verify.js messages-ui.applescript)
umask 077
GH_TOKEN="$(cat "$deploy/token")"
export GH_TOKEN GH_CONFIG_DIR="$deploy/gh" GH_PROMPT_DISABLED=1

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

probe_output=""
probe() {
  local attempt
  for ((attempt = 1; attempt <= $1; attempt++)); do
    if probe_output="$("$root/bin/bun" --env-file="$root/imsg.env" "$root/verify.js" 2>&1)"; then return 0; fi
    ((attempt == $1)) || sleep "${DEPLOY_PROBE_DELAY:-3}"
  done
  return 1
}

# Bun prints the failure as one "error: …" line between source context and a stack trace.
reason() {
  local line
  while IFS= read -r line; do
    if [[ "$line" == "error: "* ]]; then
      printf '%s' "$line"
      return
    fi
  done <<< "$probe_output"
  printf '%s' "$probe_output" | tail -c 300
}

latest="$(gh run list -R "$repository" -w ci.yml -b main -e push -L 1 --json databaseId,headSha,status --jq '.[] | "\(.databaseId) \(.headSha) \(.status)"')"
[[ -n "$latest" ]] || exit 0
read -r run sha status <<< "$latest"
[[ "$status" == completed ]] || exit 0
for known in deployed rejected; do
  [[ "$(cat "$deploy/$known" 2>/dev/null)" != "$sha" ]] || exit 0
done
# Only runs whose gates passed carry a bundle; a re-run that passes can still deploy.
[[ -n "$(gh api "repos/$repository/actions/runs/$run/artifacts" --jq '.artifacts[] | select(.name == "imsg-bundle" and (.expired | not)) | .id')" ]] || exit 0

# A commit deferred because the Mac failed the probe waits quietly until the running gateway passes.
healthy=""
if [[ "$(cat "$deploy/deferred" 2>/dev/null)" == "$sha" ]]; then
  probe 1 || exit 0
  healthy=1
fi

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

# Forced, not SIGTERM: on SIGTERM the gateway stops accepting requests and waits up to 20 s for
# the application's open stream to drain, a far longer outage. A failed restart shows up in the probe.
restart() { launchctl kickstart -k "$gateway" || true; }

unchanged=1
for name in "${runtime[@]}"; do
  cmp -s "$staging/bundle/$name" "$root/$name" || unchanged=0
done
if ((unchanged)); then
  put "$staging/bundle"
  rehash
  printf '%s\n' "$sha" > "$deploy/deployed"
  rm -f "$deploy/deferred"
  log "$sha leaves the gateway's code unchanged; installed it without a restart"
  exit 0
fi

if [[ -z "$healthy" ]]; then
  if probe 1; then
    healthy=1
  else
    healthy=0
    log "The running gateway fails the probe ($(reason)); trying $sha once"
  fi
fi

rm -rf "$deploy/previous"
mkdir "$deploy/previous"
for name in "${payload[@]}" SHA256SUMS; do cp -p "$root/$name" "$deploy/previous/$name"; done
log "Deploying $sha"
put "$staging/bundle"
rehash
restart
if probe "${DEPLOY_PROBE_ATTEMPTS:-10}"; then
  printf '%s\n' "$sha" > "$deploy/deployed"
  rm -f "$deploy/deferred"
  log "Deployed $sha"
  exit 0
fi
log "Probe failed: $(reason)"
put "$deploy/previous"
cp -p "$deploy/previous/SHA256SUMS" "$root/SHA256SUMS"
restart
if ((healthy)) && probe "${DEPLOY_PROBE_ATTEMPTS:-10}"; then
  printf '%s\n' "$sha" > "$deploy/rejected"
  log "Rolled back $sha: its gateway failed the probe; waiting for a newer commit"
else
  printf '%s\n' "$sha" > "$deploy/deferred"
  log "Rolled back $sha: the Mac fails the probe with either bundle; retrying once the running gateway passes it"
fi
exit 1
