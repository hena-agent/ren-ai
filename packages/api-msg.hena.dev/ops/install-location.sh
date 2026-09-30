#!/bin/bash
set -euo pipefail
[[ -s /input/opencode.json && -s /input/application.token ]] || { echo 'Reviewed config and service token required' >&2; exit 1; }
[[ -d /location && -z "$(ls -A /location)" ]] || { echo 'Destination persona volume must be empty; export/review existing contents instead of overwriting' >&2; exit 1; }
umask 077
cp -R /artifact/plugin /location/plugin
cp /input/opencode.json /location/opencode.json
cp /input/application.token /location/application.token
chmod 700 /location
chmod 600 /location/opencode.json /location/application.token
echo 'Installed persona location. Existing OpenCode home and sessions were not touched.'
