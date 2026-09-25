#!/bin/bash
# Time one imsg react and show the reaction row it produced.
# usage: react-probe.sh <label> <chat_id> <reaction>
set -u
DB="$HOME/Library/Messages/chat.db"
OUT="$(cd "$(dirname "$0")" && pwd)/out"
label=$1 chat=$2 reaction=$3
frontmost() { osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' 2>&1; }
before=$(sqlite3 "$DB" 'select coalesce(max(ROWID),0) from message')
fb=$(frontmost)
t0=$(gdate +%s.%3N)
imsg react --chat-id "$chat" --reaction "$reaction" --json >"$OUT/react-$label.stdout" 2>"$OUT/react-$label.stderr"
rc=$?
t1=$(gdate +%s.%3N)
{
  echo "label=$label chat=$chat reaction=$reaction frontmost_before=$fb frontmost_after=$(frontmost)"
  echo "started=$(gdate -d @"$t0" +%T.%3N) returned_after=$(echo "$t1 - $t0" | bc)s exit=$rc"
  echo "stdout: $(cat "$OUT/react-$label.stdout")"
  echo "stderr: $(cat "$OUT/react-$label.stderr")"
  sleep 2
  sqlite3 -header -column "$DB" "
    select m.ROWID as id, m.is_from_me as me, m.associated_message_type as amt,
           m.associated_message_guid as target, m.is_sent as sent, m.is_delivered as dlv, m.error as err,
           cmj.chat_id as chat
    from message m left join chat_message_join cmj on cmj.message_id = m.ROWID
    where m.ROWID > $before order by m.ROWID"
} | tee "$OUT/react-$label.log"
