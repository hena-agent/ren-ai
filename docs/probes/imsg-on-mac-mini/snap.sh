#!/bin/bash
# Snapshot of chat.db: chats, handles, and message rows (newest last).
# usage: snap.sh [min_rowid]
DB="$HOME/Library/Messages/chat.db"
MIN=${1:-0}
ts() { echo "datetime($1/1000000000 + 978307200, 'unixepoch', 'localtime')"; }
sqlite3 -header -column "$DB" "
select ROWID as chat, guid, chat_identifier as ident, service_name as svc, account_login as acct,
       successful_query as sq, last_addressed_handle as last_h, is_filtered as filt
from chat order by ROWID;"
echo
sqlite3 -header -column "$DB" "select ROWID as h, id, service, country from handle order by ROWID;"
echo
sqlite3 -header -column "$DB" "
select m.ROWID as id, substr(m.guid,1,8) as guid, m.service as svc, m.is_from_me as me,
       m.is_sent as sent, m.is_delivered as dlv, m.is_finished as fin, m.is_read as rd, m.error as err,
       strftime('%H:%M:%f', $(ts m.date)) as date,
       case when m.date_delivered > 0 then strftime('%H:%M:%f', $(ts m.date_delivered)) end as delivered,
       case when m.date_read > 0 then strftime('%H:%M:%f', $(ts m.date_read)) end as read_at,
       case when m.date_edited > 0 then strftime('%H:%M:%f', $(ts m.date_edited)) end as edited,
       case when m.date_retracted > 0 then strftime('%H:%M:%f', $(ts m.date_retracted)) end as retracted,
       m.associated_message_type as amt, substr(m.associated_message_guid,1,14) as amg,
       m.associated_message_emoji as emoji, m.cache_has_attachments as att, m.item_type as it,
       substr(m.thread_originator_guid,1,8) as thread, h.id as handle,
       replace(substr(coalesce(m.text,''),1,30), char(10), ' ') as text
from message m left join handle h on h.ROWID = m.handle_id
where m.ROWID > $MIN order by m.ROWID;"
