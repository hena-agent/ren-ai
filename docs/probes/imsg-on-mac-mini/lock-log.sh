#!/bin/bash
# Log screen-lock state changes once per second.
prev=""
while true; do
  cur=$(ioreg -n Root -d1 -a | plutil -extract IOConsoleUsers json -o - - 2>/dev/null | jq -r '.[0].CGSSessionScreenIsLocked // false')
  if [ "$cur" != "$prev" ]; then echo "$(gdate +%T.%3N) locked=$cur"; prev=$cur; fi
  sleep 1
done
