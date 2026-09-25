#!/bin/bash
# Time one iMessage-only send and follow the new rows in chat.db until they settle.
# usage: send-probe.sh <label> <handle> <text>
# env: POLL_SECS (default 120)
set -u
DB="$HOME/Library/Messages/chat.db"
OUT="$(cd "$(dirname "$0")" && pwd)/out"
mkdir -p "$OUT"
label=$1 to=$2 text=$3
log="$OUT/send-$label.log"
before=$(sqlite3 "$DB" 'select coalesce(max(ROWID),0) from message')
t0=$(gdate +%s.%3N)
imsg send --to "$to" --text "$text" --service imessage --no-sms-fallback --json \
  >"$OUT/send-$label.stdout" 2>"$OUT/send-$label.stderr"
rc=$?
t1=$(gdate +%s.%3N)
{
  echo "label=$label to=$to before_rowid=$before"
  echo "started=$(gdate -d @"$t0" +%T.%3N) returned_after=$(echo "$t1 - $t0" | bc)s exit=$rc"
  echo "stdout: $(cat "$OUT/send-$label.stdout")"
  echo "stderr: $(cat "$OUT/send-$label.stderr")"
  echo "--- row state changes (t since send started): ROWID service is_sent is_delivered is_finished error delivered read"
} | tee "$log"
prev=""
end=$(($(date +%s) + ${POLL_SECS:-120}))
while [ "$(date +%s)" -lt "$end" ]; do
  cur=$(sqlite3 -separator ' ' "$DB" "select ROWID, service, is_sent, is_delivered, is_finished, error, date_delivered > 0, date_read > 0 from message where ROWID > $before order by ROWID")
  if [ "$cur" != "$prev" ]; then
    now=$(gdate +%s.%3N)
    printf 't+%.3fs  %s\n' "$(echo "$now - $t0" | bc)" "$(echo "$cur" | tr '\n' '|')" | tee -a "$log"
    prev=$cur
  fi
  sleep 0.2
done
echo "--- final" | tee -a "$log"
"$(dirname "$0")/snap.sh" "$before" | tee -a "$log"
