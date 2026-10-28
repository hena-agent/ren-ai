import { createHash } from "node:crypto";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { Conversation } from "../conversations/conversations.ts";
import type { IncomingMessage, Messages } from "@ren-ai/imsg";
import { edited, unsent } from "../transcript/transcript.ts";

const editWindow = 15 * 60_000;
const unsendWindow = 2 * 60_000;

/** Admitted text survives actor eviction for the edit window, then is deleted. */
export const watchEdits = (
  messages: Messages,
  enqueue: (conversation: Conversation, id: string, text: string) => Effect.Effect<void, Error>,
  timeZone: (personaID: string) => string,
  signal: (conversation: Conversation) => void,
  arriving: (sessionID: string, messageID: string) => Effect.Effect<void, Error>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const remember = (conversation: Conversation, row: IncomingMessage) =>
      row.text
        ? sql`INSERT OR IGNORE INTO intake_edit (session_id, guid, created_at, text, revision)
           SELECT ${conversation.sessionID}, ${row.guid}, ${row.createdAt}, ${row.text}, 0
           WHERE EXISTS (SELECT 1 FROM conversation WHERE id = ${conversation.id} AND session_id = ${conversation.sessionID} AND ended_at IS NULL)`.pipe(
            Effect.asVoid,
          )
        : Effect.void;
    type Watched = Conversation & {
      guid: string;
      text: string;
      createdAt: number;
      revision: number;
    };
    const inspect = (entry: Watched, currentText: string, time: number) =>
      Effect.gen(function* () {
        if (currentText === entry.text) return;
        if (!currentText && entry.createdAt + unsendWindow < time) return;
        const zone = timeZone(entry.personaID);
        const text = currentText ? edited(entry.text, currentText, time, zone) : unsent(time, zone);
        const revision = entry.revision + 1;
        const promptID = `msg_edit_${createHash("sha256")
          .update(
            [entry.sessionID, entry.guid, entry.text, currentText, String(revision)].join("\0"),
          )
          .digest("hex")}`;
        yield* Effect.gen(function* () {
          yield* enqueue(entry, promptID, text);
          yield* sql`UPDATE intake_edit SET text = ${currentText}, revision = ${revision}
            WHERE session_id = ${entry.sessionID} AND guid = ${entry.guid}`;
          yield* arriving(entry.sessionID, promptID);
        }).pipe(sql.withTransaction);
        signal(entry);
      });
    const poll = Effect.gen(function* () {
      const time = yield* Clock.currentTimeMillis;
      yield* sql`DELETE FROM intake_edit WHERE created_at < ${time - editWindow}
        OR NOT EXISTS (SELECT 1 FROM conversation c WHERE c.session_id = intake_edit.session_id AND c.ended_at IS NULL)`;
      const watched =
        yield* sql<Watched>`SELECT c.id, e.session_id AS sessionID, u.handle, c.persona_id AS personaID,
        e.guid, e.text, e.created_at AS createdAt, e.revision FROM intake_edit e JOIN conversation c ON c.session_id = e.session_id
        JOIN user u ON u.id = c.user_id WHERE e.text != ''`;
      for (const handle of new Set(watched.map((entry) => entry.handle))) {
        const group = watched.filter((entry) => entry.handle === handle);
        const since = Math.min(...group.map((entry) => entry.createdAt));
        const recent = yield* messages.recent(handle, since);
        const byGuid = new Map(recent.map((row) => [row.guid, row]));
        for (const entry of group) {
          const current = byGuid.get(entry.guid);
          if (current) yield* inspect(entry, current.text, time);
        }
      }
    });
    return { remember, poll };
  });
