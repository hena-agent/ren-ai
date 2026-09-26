import { createHash } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Conversation } from "../conversations/conversations.ts";
import type { IncomingMessage, Messages } from "../messages/messages.ts";
import { message, sentByYou } from "../transcript/transcript.ts";
import { watchEdits } from "./edits.ts";

interface Bookmark {
  readonly rowID: number;
  readonly date: number;
}

const promptID = (sessionID: string, guid: string) =>
  `msg_${createHash("sha256").update(sessionID).update("\0").update(guid).digest("hex")}`;

export const intake = (
  messages: Messages,
  byHandle: (handle: string) => Effect.Effect<Conversation | undefined, Error>,
  prompt: (sessionID: string, id: string, text: string) => Effect.Effect<void, Error>,
  timeZone: (personaID: string) => string,
  reconcile?: (conversation: Conversation, row: IncomingMessage) => Effect.Effect<boolean, Error>,
  ensure?: (handle: string) => Effect.Effect<void, Error>,
  startImmediately = true,
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
    const outgoing = (row: IncomingMessage) =>
      Effect.gen(function* () {
        if (!reconcile) return;
        const conversation = yield* byHandle(row.handle);
        if (!conversation) return;
        const matched = yield* reconcile(conversation, row);
        const status = yield* messages.sendStatus(row.guid);
        if (matched || status === "failed") return;
        const seen =
          yield* sql`SELECT guid FROM intake_seen WHERE session_id = ${conversation.sessionID} AND guid = ${row.guid}`;
        if (seen.length) return;
        yield* prompt(
          conversation.sessionID,
          promptID(conversation.sessionID, row.guid),
          sentByYou(row.text, row.createdAt, timeZone(conversation.personaID)),
        );
        yield* sql`INSERT INTO intake_seen (session_id, guid) VALUES (${conversation.sessionID}, ${row.guid})`;
        signal(conversation);
      });
    const replay = (conversation: Conversation) =>
      Effect.gen(function* () {
        const active = yield* byHandle(conversation.handle);
        if (active?.sessionID !== conversation.sessionID) return;
        const notices = yield* sql<{ guid: string | null }>`SELECT guid FROM send
          WHERE handle = ${conversation.handle} AND kind = 'notice'`;
        const noticeGUIDs = new Set(notices.map((row) => row.guid));
        const started = yield* sql<{ startedAt: number }>`SELECT started_at AS startedAt
          FROM conversation WHERE id = ${conversation.id}`;
        const rows = (yield* messages.after(0))
          .filter(
            (row) => row.handle === conversation.handle && row.createdAt >= started[0]!.startedAt,
          )
          .toSorted((a, b) => a.id - b.id);
        let previous: number | null = null;
        for (const row of rows) {
          if (!(yield* byHandle(conversation.handle)) || noticeGUIDs.has(row.guid)) continue;
          const seen =
            yield* sql`SELECT 1 FROM intake_seen WHERE session_id = ${conversation.sessionID}
            AND guid = ${row.guid}`;
          if (row.fromMe) {
            if ((yield* messages.sendStatus(row.guid)) === "failed" || seen.length) continue;
            yield* prompt(
              conversation.sessionID,
              promptID(conversation.sessionID, row.guid),
              sentByYou(row.text, row.createdAt, timeZone(conversation.personaID)),
            );
          } else {
            if (seen.length) {
              previous = row.createdAt;
              continue;
            }
            yield* prompt(
              conversation.sessionID,
              promptID(conversation.sessionID, row.guid),
              message(row.text, row.createdAt, previous, timeZone(conversation.personaID)),
            );
            previous = row.createdAt;
          }
          yield* sql`INSERT OR IGNORE INTO intake_seen (session_id, guid)
            VALUES (${conversation.sessionID}, ${row.guid})`;
        }
        if (previous !== null) {
          yield* sql`INSERT INTO intake_last (conversation_id, date) VALUES (${conversation.id}, ${previous})
            ON CONFLICT(conversation_id) DO UPDATE SET date = excluded.date`;
        }
      });
    const receive = (row: IncomingMessage) =>
      Effect.gen(function* () {
        if (!replaced && row.id <= last.rowID) return;
        if (replaced && row.createdAt < current.date) return;
        if (ensure) yield* ensure(row.handle);
        if (row.fromMe) {
          yield* outgoing(row);
          last = { rowID: row.id, date: row.createdAt };
          yield* save(last);
          return;
        }
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
          yield* prompt(
            conversation.sessionID,
            promptID(conversation.sessionID, row.guid),
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
            yield* save({ rowID: row.id, date: row.createdAt });
          }).pipe(sql.withTransaction);
          last = { rowID: row.id, date: row.createdAt };
          changes.remember(conversation, row);
          signal(conversation);
          return;
        }
        last = { rowID: row.id, date: row.createdAt };
        yield* save(last);
      });
    const start = messages
      .follow(cursor, receive)
      .pipe(Effect.flatMap((stop) => Effect.addFinalizer(() => Effect.sync(stop))));
    if (startImmediately) yield* start;
    yield* Effect.forkScoped(changes.monitor);
    return {
      replay,
      start,
      onNew: (listener: (conversation: Conversation) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  });
