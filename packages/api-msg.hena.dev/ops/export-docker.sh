#!/bin/bash
set -euo pipefail
output="${1:?Usage: export-docker.sh NEW-BACKUP-DIRECTORY}"
oc="${OC_DEPLOYMENT_DIRECTORY:?Point at the reviewed existing OpenCode Compose directory}"
app="${REN_AI_APP_ENV:?Set the protected application env file}"
personas="${REN_AI_PERSONAS:?Set the reviewed persona directory}"
tunnel="${REN_AI_TUNNEL_TOKEN:?Set the application Cloudflare Tunnel token so relocation preserves it}"
volumes=("${REN_AI_STATE_VOLUME:-ren-ai-application-state}" "${OC_HOME_VOLUME:-oc-hena-dev_opencode-home}" "${OC_PROXY_VOLUME:-oc-hena-dev_auth-proxy-data}" "${REN_AI_LOCATION_VOLUME:-ren-ai-opencode-location}" "${REN_AI_SESSION_VOLUME:-ren-ai-opencode-sessions}")
[[ "$(printf '%s\n' "${volumes[@]}" | sort -u | wc -l | tr -d ' ')" == 5 ]] || { echo 'Five distinct volume names are required' >&2; exit 1; }
[[ ! -e "$output" ]] || { echo 'Use a new backup directory' >&2; exit 1; }
for volume in "${volumes[@]}"; do
  docker volume inspect "$volume" >/dev/null
  [[ -z "$(docker ps --filter "volume=$volume" --format '{{.ID}}')" ]] || { echo "Stop every service using $volume first (including the cookie proxy)" >&2; exit 1; }
done
umask 077
mkdir -p "$output/volumes"
output="$(cd "$output" && pwd)"
cp "$app" "$output/application.env"
printf '%s' "$tunnel" > "$output/application-tunnel.token"
cp -R "$personas" "$output/personas"
cp -R "$oc" "$output/opencode-deployment"
cp "$(dirname "$0")/opencode.sessions.compose.yml" "$output/opencode.sessions.compose.yml"
for index in "${!volumes[@]}"; do
  docker run --rm --network none --mount "type=volume,src=${volumes[$index]},dst=/volume,readonly" --mount "type=bind,src=$output/volumes,dst=/backup" alpine:3.22.1 tar -cpf "/backup/$index.tar" -C /volume .
done
printf '%s\n' "${volumes[@]}" > "$output/source-volumes.txt"
(
  cd "$output"
  find . -type f ! -name SHA256SUMS -exec shasum -a 256 {} \; > SHA256SUMS
)
echo 'Stopped Docker state/config/credentials exported. Fleet uses ops/mdm backup tooling; encrypt and copy this private archive off-host.'
