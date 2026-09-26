import { createHash } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Conversation } from "../conversations/conversations.ts";
import type { IncomingMessage, Messages } from "../messages/messages.ts";
import { message } from "../transcript/transcript.ts";
import { watchEdits } from "./edits.ts";

interface Bookmark {
  readonly rowID: number;
  readonly date: number;
}

export const intake = (
  messages: Messages,
  byHandle: (handle: string) => Effect.Effect<Conversation | undefined, Error>,
  prompt: (sessionID: string, id: string, text: string) => Effect.Effect<void, Error>,
  timeZone: (personaID: string) => string,
  received: (conversation: Conversation, date: number) => Effect.Effect<void, Error> = () =>
    Effect.void,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const listeners = new Set<(conversation: Conversation) => void>();
    const signal = (conversation: Conversation) => {
      for (const listener of listeners) listener(conversation);
    };
    const changes = yield* watchEdits(messages, prompt, timeZone, signal);
    const bookmark = () =>
      Effect.map(
        sql<Bookmark>`SELECT row_id AS rowID, date FROM bookmark WHERE id = 1`,
        (rows) => rows[0],
      );
    const save = (row: Bookmark) =>
      sql`INSERT INTO bookmark (id, row_id, date) VALUES (1, ${row.rowID}, ${row.date})
        ON CONFLICT(id) DO UPDATE SET row_id = excluded.row_id, date = excluded.date`;
    let current = yield* bookmark();
    const history = yield* messages.after(0);
    if (!current) {
      const tail = history.at(-1);
      current = { rowID: tail?.id ?? 0, date: tail?.createdAt ?? 0 };
      yield* save(current);
    }
    const replaced = history.find((row) => row.id === current.rowID)?.createdAt !== current.date;
    const cursor = replaced ? 0 : current.rowID;
    let last = current;
    const receive = (row: IncomingMessage) =>
      Effect.gen(function* () {
        if (!replaced && row.id <= last.rowID) return;
        if (replaced && row.createdAt < current.date) return;
        if (!row.fromMe) {
          const conversation = yield* byHandle(row.handle);
          if (conversation) {
            const seen =
              yield* sql`SELECT guid FROM intake_seen WHERE session_id = ${conversation.sessionID} AND guid = ${row.guid}`;
            if (seen.length) {
              last = { rowID: row.id, date: row.createdAt };
              yield* save(last);
              return;
            }
            const earlier = yield* sql<{
              date: number;
            }>`SELECT date FROM intake_last WHERE conversation_id = ${conversation.id}`;
            const id = `msg_${createHash("sha256").update(conversation.sessionID).update("\0").update(row.guid).digest("hex")}`;
            yield* prompt(
              conversation.sessionID,
              id,
              message(
                row.text,
                row.createdAt,
                earlier[0]?.date ?? null,
                timeZone(conversation.personaID),
              ),
            );
            yield* Effect.gen(function* () {
              yield* sql`INSERT INTO intake_seen (session_id, guid) VALUES (${conversation.sessionID}, ${row.guid})`;
              yield* sql`INSERT INTO intake_last (conversation_id, date) VALUES (${conversation.id}, ${row.createdAt})
                ON CONFLICT(conversation_id) DO UPDATE SET date = excluded.date`;
              yield* sql`UPDATE user SET replied_at = COALESCE(replied_at, ${row.createdAt}) WHERE id =
                (SELECT user_id FROM conversation WHERE id = ${conversation.id})`;
              yield* received(conversation, row.createdAt);
              yield* save({ rowID: row.id, date: row.createdAt });
            }).pipe(sql.withTransaction);
            last = { rowID: row.id, date: row.createdAt };
            changes.remember(conversation, row);
            signal(conversation);
            return;
          }
        }
        last = { rowID: row.id, date: row.createdAt };
        yield* save(last);
      });
    const stop = yield* messages.follow(cursor, receive);
    yield* Effect.addFinalizer(() => Effect.sync(stop));
    yield* Effect.forkScoped(changes.monitor);
    return {
      onNew: (listener: (conversation: Conversation) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  });
