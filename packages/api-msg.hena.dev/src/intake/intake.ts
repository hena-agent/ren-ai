import { createHash } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Conversation } from "../conversations/conversations.ts";
import type { IncomingMessage, Messages } from "../messages/messages.ts";
import {
  gap,
  message,
  photo,
  placeholder,
  reply,
  sentByYou,
  tapback,
} from "../transcript/transcript.ts";
import { watchEdits } from "./edits.ts";
import { imageData, imageMime } from "./images.ts";

export interface PromptImage {
  readonly uri: string;
}

interface Bookmark {
  readonly rowID: number;
  readonly date: number;
}

const promptID = (sessionID: string, guid: string) =>
  `msg_${createHash("sha256").update(sessionID).update("\0").update(guid).digest("hex")}`;

export const intake = (
  messages: Messages,
  byHandle: (handle: string) => Effect.Effect<Conversation | undefined, Error>,
  prompt: (
    sessionID: string,
    id: string,
    text: string,
    files?: ReadonlyArray<PromptImage>,
  ) => Effect.Effect<void, Error>,
  timeZone: (personaID: string) => string,
  reconcile?: (conversation: Conversation, row: IncomingMessage) => Effect.Effect<boolean, Error>,
  received: (conversation: Conversation, date: number) => Effect.Effect<void, Error> = () =>
    Effect.void,
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
        if (status === "sent" || status === "delivered")
          yield* received(conversation, row.createdAt);
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
    const target = (row: IncomingMessage, guid: string) =>
      Effect.map(messages.recent(row.handle, 0), (rows) => {
        const found = rows.find((item) => item.guid === guid);
        if (!found) return "message unavailable";
        const content = found.text || (found.attachments?.length ? "photo" : "message unavailable");
        return `${found.fromMe ? "your" : "his"} message: ${content}`;
      });
    const content = (row: IncomingMessage, previous: number | null, zone: string) =>
      Effect.gen(function* () {
        if (row.tapback) {
          return {
            text: `${gap(row.createdAt, previous, zone)}${tapback(row.tapback.emoji, yield* target(row, row.tapback.targetGuid), row.createdAt, zone)}`,
            files: Array.of<PromptImage>(),
          };
        }
        const lines: string[] = [];
        const files: PromptImage[] = [];
        if (row.replyToGuid)
          lines.push(reply(row.text, yield* target(row, row.replyToGuid), row.createdAt, zone));
        else if (row.text) lines.push(message(row.text, row.createdAt, null, zone));
        for (const attachment of row.attachments ?? []) {
          const mime = imageMime(attachment);
          if (mime && !attachment.missing) {
            const image = yield* imageData(attachment);
            lines.push(photo(row.createdAt, zone));
            files.push(image);
          } else {
            const kind = attachment.mimeType?.startsWith("audio/")
              ? "voice-memo"
              : attachment.mimeType?.startsWith("video/")
                ? "video"
                : "file";
            lines.push(placeholder(kind, row.createdAt, zone));
          }
        }
        if (row.payload) lines.push(placeholder(row.payload, row.createdAt, zone));
        if (!lines.length) lines.push(placeholder("app", row.createdAt, zone));
        return { text: `${gap(row.createdAt, previous, zone)}${lines.join("\n")}`, files };
      });
    const replayOutgoing = (conversation: Conversation, row: IncomingMessage, seen: boolean) =>
      Effect.gen(function* () {
        if ((yield* messages.sendStatus(row.guid)) === "failed") return false;
        if (seen) return true;
        yield* prompt(
          conversation.sessionID,
          promptID(conversation.sessionID, row.guid),
          sentByYou(row.text, row.createdAt, timeZone(conversation.personaID)),
        );
        return true;
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
        const [followUp] = yield* sql<{ lastSentAt: number }>`SELECT last_sent_at AS lastSentAt
          FROM follow_up WHERE conversation_id = ${conversation.id}`;
        const rows = (yield* messages.after(0))
          .filter(
            (row) =>
              row.handle === conversation.handle &&
              row.createdAt >= started[0]!.startedAt &&
              row.tapback?.added !== false,
          )
          .toSorted((a, b) => a.id - b.id);
        let previous: number | null = null;
        let firstReply: number | null = null;
        let latest = followUp?.lastSentAt ?? 0;
        for (const row of rows) {
          if (
            (yield* byHandle(conversation.handle))?.sessionID !== conversation.sessionID ||
            noticeGUIDs.has(row.guid)
          )
            continue;
          const seen =
            yield* sql`SELECT 1 FROM intake_seen WHERE session_id = ${conversation.sessionID}
              AND guid = ${row.guid}`;
          if (row.fromMe) {
            if (!(yield* replayOutgoing(conversation, row, seen.length > 0))) continue;
          } else {
            firstReply ??= row.createdAt;
            if (seen.length) {
              previous = row.createdAt;
              latest = Math.max(latest, row.createdAt);
              continue;
            }
            const rendered = yield* content(row, previous, timeZone(conversation.personaID));
            yield* prompt(
              conversation.sessionID,
              promptID(conversation.sessionID, row.guid),
              rendered.text,
              rendered.files,
            );
            previous = row.createdAt;
          }
          latest = Math.max(latest, row.createdAt);
          yield* sql`INSERT OR IGNORE INTO intake_seen (session_id, guid)
            VALUES (${conversation.sessionID}, ${row.guid})`;
        }
        if ((yield* byHandle(conversation.handle))?.sessionID !== conversation.sessionID) return;
        if (previous !== null) {
          yield* sql`INSERT INTO intake_last (conversation_id, date) VALUES (${conversation.id}, ${previous})
            ON CONFLICT(conversation_id) DO UPDATE SET date = excluded.date`;
          yield* sql`UPDATE user SET replied_at = COALESCE(replied_at, ${firstReply}) WHERE handle = ${conversation.handle}`;
        }
        if (latest > (followUp?.lastSentAt ?? 0)) yield* received(conversation, latest);
      });
    const receive = (row: IncomingMessage) =>
      Effect.gen(function* () {
        if (!replaced && row.id <= last.rowID && row.createdAt <= last.date) return;
        if (replaced && row.createdAt < current.date) return;
        if (row.tapback && !row.tapback.added) {
          last = { rowID: row.id, date: row.createdAt };
          yield* save(last);
          return;
        }
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
          const rendered = yield* content(
            row,
            earlier[0]?.date ?? null,
            timeZone(conversation.personaID),
          );
          yield* prompt(
            conversation.sessionID,
            promptID(conversation.sessionID, row.guid),
            rendered.text,
            rendered.files,
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
