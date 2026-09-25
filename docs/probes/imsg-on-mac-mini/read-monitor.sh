#!/bin/bash
# Log changes to an outgoing row's read state. usage: read-monitor.sh <rowid> [secs]
DB="$HOME/Library/Messages/chat.db"
row=$1; end=$(( $(date +%s) + ${2:-600} )); prev=""
while [ "$(date +%s)" -lt "$end" ]; do
  cur=$(sqlite3 -separator ' ' "$DB" "select m.is_read, m.is_delivered, case when m.date_read>0 then strftime('%H:%M:%f', datetime(m.date_read/1000000000+978307200,'unixepoch','localtime')) else '-' end, c.last_read_message_timestamp from message m join chat_message_join cmj on cmj.message_id=m.ROWID join chat c on c.ROWID=cmj.chat_id where m.ROWID=$row")
  if [ "$cur" != "$prev" ]; then printf '%s  is_read/is_delivered/date_read/chat.last_read_ts: %s\n' "$(gdate +%T.%3N)" "$cur"; prev=$cur; fi
  sleep 0.2
done
