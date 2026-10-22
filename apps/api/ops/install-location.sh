#!/bin/bash
set -euo pipefail
[[ -s /input/opencode.json ]] || { echo 'Reviewed config required' >&2; exit 1; }
[[ -d /location && -z "$(ls -A /location)" ]] || { echo 'Destination persona volume must be empty; export/review existing contents instead of overwriting' >&2; exit 1; }
umask 077
cp -R /artifact/plugins /location/plugins
mkdir /location/personas /location/sandboxes
cp /input/opencode.json /location/opencode.json
chmod 700 /location
chmod 600 /location/opencode.json
echo 'Installed persona location. Existing OpenCode home and sessions were not touched.'
