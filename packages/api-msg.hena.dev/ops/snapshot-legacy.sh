#!/bin/bash
set -euo pipefail
state="${1:?Usage: snapshot-legacy.sh STOPPED-STATE-DIRECTORY NEW-OUTPUT-DIRECTORY}"
output="${2:?A new output directory is required}"
[[ "${CONFIRM_SOURCE_STOPPED:-}" == yes && ! -e "$output" ]] || { echo 'Stop old intake/scheduling first; set CONFIRM_SOURCE_STOPPED=yes and use a new destination' >&2; exit 1; }
[[ -s "$state/server.sqlite" && -s "$state/opencode.sqlite" ]] || { echo 'Both legacy databases are required' >&2; exit 1; }
command -v lsof >/dev/null
if lsof -t "$state/server.sqlite" "$state/opencode.sqlite" >/dev/null 2>&1; then
  echo 'A source database is still open; snapshot refused' >&2
  exit 1
fi
umask 077
mkdir -p "$output/application-state"
tar -cf - --exclude='./server.sqlite*' --exclude='./opencode.sqlite*' -C "$state" . | tar -xf - -C "$output/application-state"
/usr/bin/python3 - "$state" "$output" <<'PY'
import sqlite3, sys
from pathlib import Path
source, target = map(Path, sys.argv[1:])
for name, dest in [('server.sqlite', target / 'application-state/server.sqlite'), ('opencode.sqlite', target / 'opencode.sqlite')]:
    with sqlite3.connect((source / name).resolve().as_uri() + '?mode=ro', uri=True) as src:
        with sqlite3.connect(dest) as dst:
            src.backup(dst)
            if dst.execute('PRAGMA integrity_check').fetchone() != ('ok',):
                raise RuntimeError(name + ' failed integrity check')
PY
echo 'Preserved complete legacy state plus coherent SQLite copies. Keep the old source stopped until cutover or rollback.'
