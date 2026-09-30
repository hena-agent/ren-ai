#!/bin/bash
set -euo pipefail
backup="${1:?Usage: restore-docker.sh VERIFIED-BACKUP-DIRECTORY NEW-CONFIG-DIRECTORY}"
destination="${2:?Use a new config directory}"
backup="$(cd "$backup" && pwd)"
volumes=("${REN_AI_STATE_VOLUME:-ren-ai-application-state}" "${OC_HOME_VOLUME:-oc-hena-dev_opencode-home}" "${OC_PROXY_VOLUME:-oc-hena-dev_auth-proxy-data}" "${REN_AI_LOCATION_VOLUME:-ren-ai-opencode-location}")
[[ "$(printf '%s\n' "${volumes[@]}" | sort -u | wc -l | tr -d ' ')" == 4 ]] || { echo 'Four distinct volume names are required' >&2; exit 1; }
[[ ! -e "$destination" ]] || { echo 'Existing config is never overwritten' >&2; exit 1; }
(
  cd "$backup"
  shasum -a 256 -c SHA256SUMS
)
for index in "${!volumes[@]}"; do
  [[ -s "$backup/volumes/$index.tar" ]] || { echo "Missing volume archive $index" >&2; exit 1; }
  if docker volume inspect "${volumes[$index]}" >/dev/null 2>&1; then
    echo "Destination volume ${volumes[$index]} already exists; restore never merges or overwrites sessions" >&2
    exit 1
  fi
done
umask 077
mkdir -p "$destination"
cp "$backup/application.env" "$destination/application.env"
cp "$backup/application-tunnel.token" "$destination/application-tunnel.token"
cp -R "$backup/personas" "$destination/personas"
cp -R "$backup/opencode-deployment" "$destination/opencode-deployment"
for index in "${!volumes[@]}"; do
  docker volume create "${volumes[$index]}" >/dev/null
  docker run --rm --network none --mount "type=volume,src=${volumes[$index]},dst=/volume" --mount "type=bind,src=$backup/volumes,dst=/backup,readonly" alpine:3.22.1 tar -xpf "/backup/$index.tar" -C /volume
done
echo 'Restored WITHOUT STARTING. Review host paths, set BOOTSTRAP_ONLY=true, validate integration before moving tunnel traffic.'
