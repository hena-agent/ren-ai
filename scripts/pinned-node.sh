#!/bin/sh
# Git hooks inherit whatever Node the developer's shell happens to expose, but
# quality checks require the version pinned in .nvmrc. Switch to it when nvm is
# installed; otherwise run the command unchanged so non-nvm setups are unaffected.
set -e

NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1090,SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use >/dev/null 2>&1 || true
fi

exec "$@"
