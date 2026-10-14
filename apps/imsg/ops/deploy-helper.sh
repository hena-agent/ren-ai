#!/bin/bash
# Shared attested-artifact installer for the unchanged imsg and api-msg services.
set -euo pipefail
profile="${1:?Usage: deploy-helper.sh imsg|api-msg INSTALLED-HOME}"
root="${2:?Usage: deploy-helper.sh imsg|api-msg INSTALLED-HOME}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
deploy="$root/deploy"
repository=hena-agent/ren-ai
case "$profile" in
  imsg)
    artifact=imsg-bundle
    gateway="gui/$(id -u)/im.renai.imsg"
    payload=(imsg.js verify.js messages-ui.applescript imsg.graph.json verify.graph.json)
    runtime=(imsg.js verify.js messages-ui.applescript)
    probe_command=("$root/bin/bun" "--env-file=$root/imsg.env" "$root/verify.js")
    ;;
  api-msg)
    artifact=api-msg-bundle
    gateway="gui/$(id -u)/im.renai.api-msg"
    payload=(api-msg.js api-msg-verify.js api-msg.graph.json api-msg-verify.graph.json artifact.info)
    runtime=(api-msg.js api-msg-verify.js)
    probe_command=("$root/bin/bun" "--env-file=$root/api-msg.env" "$root/api-msg-verify.js")
    ;;
  *) echo 'Unknown deploy profile' >&2; exit 2 ;;
esac
umask 077
GH_TOKEN="$(<"$deploy/token")"
export GH_TOKEN GH_CONFIG_DIR="$deploy/gh" GH_PROMPT_DISABLED=1

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

probe_output=""
probe() {
  local attempt
  for ((attempt = 1; attempt <= $1; attempt++)); do
    if probe_output="$("${probe_command[@]}" 2>&1)"; then return 0; fi
    ((attempt == $1)) || sleep "${DEPLOY_PROBE_DELAY:-3}"
  done
  return 1
}

# Keep at most one sanitized error line; api-msg probes never print response bodies.
reason() {
  local line
  while IFS= read -r line; do
    if [[ "$line" == "error: "* || "$line" == "Error: "* ]]; then
      printf '%s' "${line:0:240}"
      return
    fi
  done <<< "$probe_output"
  printf 'probe failed without a safe diagnostic'
}

latest="$(gh run list -R "$repository" -w ci.yml -b main -e push -L 1 --json databaseId,headSha,status --jq '.[] | "\(.databaseId) \(.headSha) \(.status)"')"
[[ -n "$latest" ]] || exit 0
read -r run sha status <<< "$latest"
[[ "$status" == completed ]] || exit 0
for known in deployed rejected; do
  [[ "$(cat "$deploy/$known" 2>/dev/null || true)" != "$sha" ]] || exit 0
done
[[ -n "$(gh api "repos/$repository/actions/runs/$run/artifacts" --jq ".artifacts[] | select(.name == \"$artifact\" and (.expired | not)) | .id")" ]] || exit 0

healthy=""
if [[ "$(cat "$deploy/deferred" 2>/dev/null || true)" == "$sha" ]]; then
  probe 1 || exit 0
  healthy=1
fi

staging="$(mktemp -d "$deploy/staging.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
gh run download "$run" -R "$repository" -n "$artifact" -D "$staging"
gh attestation verify "$staging/$artifact.tar.gz" -R "$repository" \
  --signer-workflow "github.com/$repository/.github/workflows/ci.yml" \
  --source-ref refs/heads/main --source-digest "$sha" --deny-self-hosted-runners > /dev/null
mkdir "$staging/bundle"
tar -xzf "$staging/$artifact.tar.gz" -C "$staging/bundle"
(
  cd "$staging/bundle"
  if [[ "$profile" == api-msg ]]; then
    verifier="$script_dir/verify-artifact.sh"
    [[ -f "$verifier" ]] || verifier="$script_dir/../../api-msg/ops/verify-artifact.sh"
    bash "$verifier" "$staging/bundle"
  fi
)
for name in "${payload[@]}"; do
  [[ -s "$staging/bundle/$name" ]] || { log "Bundle for $sha lacks $name"; exit 1; }
done

put() {
  local name
  for name in "${payload[@]}"; do
    cp "$1/$name" "$root/.$name.next"
    mv -f "$root/.$name.next" "$root/$name"
  done
}

rehash() {
  {
    awk -v names="${payload[*]}" 'BEGIN { split(names, list, " "); for (i in list) skip["./" list[i]] = 1 } !($2 in skip)' "$root/SHA256SUMS"
    (cd "$root" && shasum -a 256 "${payload[@]/#/./}")
  } > "$root/.SHA256SUMS.next"
  mv -f "$root/.SHA256SUMS.next" "$root/SHA256SUMS"
}

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
  if [[ "$profile" == imsg ]]; then
    log "$sha leaves the gateway's code unchanged; installed it without a restart"
  else
    log "$sha changes metadata only; installed without a service restart"
  fi
  exit 0
fi

if [[ -z "$healthy" ]]; then
  if probe 1; then
    healthy=1
  else
    healthy=0
    if [[ "$profile" == imsg ]]; then
      log "The running gateway fails the probe ($(reason)); trying $sha once"
    else
      log "Running api-msg probe failed ($(reason)); trying $sha once"
    fi
  fi
fi

rm -rf "$deploy/previous"
mkdir "$deploy/previous"
for name in "${payload[@]}" SHA256SUMS; do cp -p "$root/$name" "$deploy/previous/$name"; done
if [[ "$profile" == imsg ]]; then
  log "Deploying $sha"
else
  log "Deploying api-msg $sha"
fi
put "$staging/bundle"
rehash
restart
if probe "${DEPLOY_PROBE_ATTEMPTS:-10}"; then
  printf '%s\n' "$sha" > "$deploy/deployed"
  rm -f "$deploy/deferred"
  if [[ "$profile" == imsg ]]; then
    log "Deployed $sha"
  else
    log "Deployed api-msg $sha"
  fi
  exit 0
fi
log "Probe failed: $(reason)"
put "$deploy/previous"
cp -p "$deploy/previous/SHA256SUMS" "$root/SHA256SUMS"
restart
if ((healthy)) && probe "${DEPLOY_PROBE_ATTEMPTS:-10}"; then
  printf '%s\n' "$sha" > "$deploy/rejected"
  if [[ "$profile" == imsg ]]; then
    log "Rolled back $sha: its gateway failed the probe; waiting for a newer commit"
  else
    log "Rolled back $sha: the api-msg bundle failed its probe; waiting for a newer commit"
  fi
else
  printf '%s\n' "$sha" > "$deploy/deferred"
  if [[ "$profile" == imsg ]]; then
    log "Rolled back $sha: the Mac fails the probe with either bundle; retrying once the running gateway passes it"
  else
    log "Rolled back $sha: the Mac fails the api-msg probe; waiting for recovery"
  fi
fi
exit 1
