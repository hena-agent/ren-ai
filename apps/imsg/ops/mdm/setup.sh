#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
if [[ ! -f .env ]]; then
  password=$(openssl rand -hex 32)
  root_password=$(openssl rand -hex 32)
  private_key=$(openssl rand -base64 32)
  (
    set -o noclobber
    {
      printf 'FLEET_URL=https://fleet.hena.dev\nFLEET_LOCAL_PORT=8081\n'
      printf 'MYSQL_PASSWORD=%s\n' "$password"
      printf 'MYSQL_ROOT_PASSWORD=%s\n' "$root_password"
      printf 'FLEET_SERVER_PRIVATE_KEY=%s\n' "$private_key"
    } > .env
  )
fi
chmod 600 .env
docker compose up -d --wait mysql redis fleet
printf 'Fleet is ready locally. Create the initial administrator on the loopback UI BEFORE public routing; then route fleet.hena.dev and run attended-setup.sh.\n'
