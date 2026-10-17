import { createHash } from "node:crypto";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Conversation } from "../conversations/conversations.ts";
import type { IncomingMessage, Messages } from "@ren-ai/imsg";
import { edited, unsent } from "../transcript/transcript.ts";

const editWindow = 15 * 60_000;
const unsendWindow = 2 * 60_000;

interface WatchedMessage {
  readonly row: IncomingMessage;
  text: string;
  revision: number;
}

interface WatchedConversation {
  readonly conversation: Conversation;
  readonly rows: Map<string, WatchedMessage>;
}

/** Observed edits keep their original prompt IDs and retry through the durable intake queue. */
export const watchEdits = (
  messages: Messages,
  enqueue: (conversation: Conversation, id: string, text: string) => Effect.Effect<void, Error>,
  timeZone: (personaID: string) => string,
  signal: (conversation: Conversation) => void,
  arriving: (sessionID: string, messageID: string) => Effect.Effect<void, Error>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const watched = new Map<string, WatchedConversation>();
    const remember = (conversation: Conversation, row: IncomingMessage) =>
      Effect.gen(function* () {
        yield* sql`INSERT OR IGNORE INTO intake_edit (session_id, guid, text, revision)
        SELECT ${conversation.sessionID}, ${row.guid}, ${row.text}, 0 WHERE ${row.text} != ''`;
        const [saved] = yield* sql<{
          text: string;
          revision: number;
        }>`SELECT text, revision FROM intake_edit
        WHERE session_id = ${conversation.sessionID} AND guid = ${row.guid}`;
        if (!saved?.text) return;
        let group = watched.get(conversation.sessionID);
        if (!group) {
          group = { conversation, rows: new Map() };
          watched.set(conversation.sessionID, group);
        }
        group.rows.set(row.guid, { row, text: saved.text, revision: saved.revision });
      });
    const now = yield* Clock.currentTimeMillis;
    const active = yield* sql<Conversation>`SELECT conversation.id, user.handle,
      conversation.persona_id AS personaID, conversation.session_id AS sessionID
      FROM conversation JOIN user ON user.id = conversation.user_id
      WHERE conversation.ended_at IS NULL AND conversation.last_received_at >= ${now - editWindow}`;
    for (const conversation of active) {
      const seen = yield* sql<{
        guid: string;
      }>`SELECT guid FROM intake_seen WHERE session_id = ${conversation.sessionID}`;
      const known = new Set(seen.map((item) => item.guid));
      const recent = yield* messages.recent(conversation.handle, now - editWindow);
      for (const row of recent) {
        if (known.has(row.guid)) yield* remember(conversation, row);
      }
    }
    const inspect = (
      group: WatchedConversation,
      guid: string,
      entry: WatchedMessage,
      currentText: string,
      time: number,
    ) =>
      Effect.gen(function* () {
        if (currentText === entry.text) return;
        if (!currentText && entry.row.createdAt + unsendWindow < time) return;
        const zone = timeZone(group.conversation.personaID);
        const text = currentText ? edited(entry.text, currentText, time, zone) : unsent(time, zone);
        const revision = entry.revision + 1;
        const promptID = `msg_edit_${createHash("sha256")
          .update(
            [group.conversation.sessionID, guid, entry.text, currentText, String(revision)].join(
              "\0",
            ),
          )
          .digest("hex")}`;
        yield* Effect.gen(function* () {
          yield* enqueue(group.conversation, promptID, text);
          yield* sql`UPDATE intake_edit SET text = ${currentText}, revision = ${revision}
            WHERE session_id = ${group.conversation.sessionID} AND guid = ${guid}`;
          yield* arriving(group.conversation.sessionID, promptID);
        }).pipe(sql.withTransaction);
        entry.text = currentText;
        entry.revision = revision;
        signal(group.conversation);
        if (!currentText) group.rows.delete(guid);
      });
    const poll = Effect.gen(function* () {
      const time = yield* Clock.currentTimeMillis;
      for (const [id, group] of watched) {
        for (const [guid, entry] of group.rows) {
          if (entry.row.createdAt + editWindow < time) group.rows.delete(guid);
        }
        if (!group.rows.size) {
          watched.delete(id);
          continue;
        }
        const since = Math.min(...[...group.rows.values()].map((entry) => entry.row.createdAt));
        const recent = yield* messages.recent(group.conversation.handle, since);
        const byGuid = new Map(recent.map((row) => [row.guid, row]));
        for (const [guid, entry] of group.rows) {
          const current = byGuid.get(guid);
          if (current) yield* inspect(group, guid, entry, current.text, time);
        }
      }
    });
    return { remember, poll };
  });
