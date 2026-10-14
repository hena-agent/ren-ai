#!/usr/bin/env bash
set -euo pipefail
umask 077
action="${1:?Usage: fleet-data.sh export|restore /absolute/backup-directory}"
destination="${2:?A backup directory is required}"
[[ "$destination" == /* ]] || { printf 'Use an absolute backup path.\n' >&2; exit 1; }
cd "$(dirname "$0")"

case "$action" in
  export)
    # Fail if the destination already exists; never overwrite another snapshot.
    mkdir -m 700 "$destination"
    cp .env "$destination/setup.env"
    cp compose.yaml "$destination/compose.yaml"
    export FLEET_BACKUP_DIR="$destination"
    trap 'docker compose up -d --wait mysql redis fleet' EXIT
    docker compose stop fleet mysql redis
    docker compose --profile maintenance run --rm -T --no-deps snapshot \
      tar -C /snapshot -czf /backup/fleet-volumes.tgz mysql redis fleet
    chmod 600 "$destination"/*
    (cd "$destination" && shasum -a 256 fleet-volumes.tgz setup.env compose.yaml > SHA256SUMS)
    printf 'Fleet snapshot written. Protect this directory: it contains certificates and credentials.\n'
    ;;
  restore)
    [[ ! -e .env ]] || { printf 'Restore requires a fresh deployment directory without .env.\n' >&2; exit 1; }
    (cd "$destination" && shasum -a 256 -c SHA256SUMS)
    cmp -s compose.yaml "$destination/compose.yaml" || { printf 'Use the snapshot\047s pinned Compose file before restoring.\n' >&2; exit 1; }
    printf 'Restore Fleet certificates and data into EMPTY volumes only? Type RESTORE: '
    read -r approval
    [[ "$approval" == RESTORE ]] || exit 1
    cp "$destination/setup.env" .env
    chmod 600 .env
    export FLEET_BACKUP_DIR="$destination"
    # Never clear an existing volume. Refuse it, even after human confirmation.
    docker compose --profile maintenance run --rm -T --no-deps snapshot sh -ec \
      'for volume in mysql redis fleet; do test -z "$(ls -A "/snapshot/$volume")" || { echo "Nonempty volume: $volume" >&2; exit 1; }; done; tar -C /snapshot -xzf /backup/fleet-volumes.tgz'
    docker compose up -d --wait mysql redis fleet
    printf 'Fleet restored locally. Verify admin login, APNs certificate and profiles before moving public ingress.\n'
    ;;
  *) printf 'Use export or restore.\n' >&2; exit 1 ;;
esac
