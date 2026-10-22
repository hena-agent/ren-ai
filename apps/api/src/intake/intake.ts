import { Effect, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Conversation } from "../conversations/conversations.ts";
import type { IncomingMessage, Messages } from "@ren-ai/imsg";
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
import { imageMime } from "@ren-ai/imsg";
import { resetBoundary } from "../conversations/reset-boundary.ts";
import { intakeQueue } from "./queue.ts";
import { scheduleWork } from "../scheduling.ts";
import { promptID } from "./message-id.ts";
import { claimWork, DeferredWork } from "../work-budget.ts";

const ReplayProgress = Schema.fromJsonString(
  Schema.Struct({
    cursor: Schema.Number,
    previous: Schema.NullOr(Schema.Number),
  }),
);

const observeWhileWaiting = <E, R>(observe: Effect.Effect<void, E, R>, cursor: () => number) =>
  Effect.suspend(() => {
    let delay = 1_000;
    return Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(delay);
        const before = cursor();
        yield* observe;
        delay = cursor() !== before ? 1_000 : Math.min(delay * 2, 30_000);
      }),
    );
  });

export interface PromptImage {
  readonly uri: string;
}

interface Bookmark {
  readonly rowID: number;
  readonly date: number;
}

type Prompt = (
  sessionID: string,
  id: string,
  text: string,
  files?: ReadonlyArray<PromptImage>,
) => Effect.Effect<void, Error>;

const readBookmark = (messages: Messages) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    let [current] = yield* sql<Bookmark>`SELECT row_id AS rowID, date FROM bookmark WHERE id = 1`;
    const history = yield* messages.after(
      Math.max(0, (current?.rowID ?? 1) - 1),
      current ? 101 : undefined,
    );
    if (!current) {
      const tail = history.at(-1);
      current = { rowID: tail?.id ?? 0, date: tail?.createdAt ?? 0 };
      yield* sql`INSERT INTO bookmark (id, row_id, date) VALUES (1, ${current.rowID}, ${current.date})
      ON CONFLICT(id) DO UPDATE SET row_id = excluded.row_id, date = excluded.date`;
    }
    return { current, history };
  });

export const intake = (
  messages: Messages,
  byHandle: (handle: string) => Effect.Effect<Conversation | undefined, Error>,
  prompt: Prompt,
  timeZone: (personaID: string) => string,
  reconcile?: (conversation: Conversation, row: IncomingMessage) => Effect.Effect<boolean, Error>,
  received: (conversation: Conversation, date: number) => Effect.Effect<void, Error> = () =>
    Effect.void,
  ensure?: (handle: string) => Effect.Effect<void, Error>,
  startImmediately = true,
  sent: (conversation: Conversation, date: number) => Effect.Effect<void, Error> = () =>
    Effect.void,
  reset: (row: IncomingMessage) => Effect.Effect<void, Error> = () => Effect.void,
  arriving: (sessionID: string, messageID: string) => Effect.Effect<void, Error> = () =>
    Effect.void,
  admit: (
    conversation: Conversation,
    action: Effect.Effect<void, Error>,
  ) => Effect.Effect<void, Error> = (_conversation, action) => action,
  replayPrompt: Prompt = prompt,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pollLock = yield* Semaphore.make(1);
    const drainLock = yield* Semaphore.make(1);
    const queue = yield* intakeQueue;
    const beforeReset = yield* resetBoundary(messages);
    const listeners = new Set<(conversation: Conversation) => void>();
    const signal = (conversation: Conversation) => {
      for (const listener of listeners) listener(conversation);
    };
    const changes = yield* watchEdits(messages, queue.enqueueEdit, timeZone, signal, arriving);
    // Native admission and this receipt share the handle lock with session replacement.
    const markSeen = (sessionID: string, guid: string) =>
      sql`INSERT INTO intake_seen (session_id, guid) SELECT ${sessionID}, ${guid}
        WHERE EXISTS (SELECT 1 FROM conversation WHERE session_id = ${sessionID} AND ended_at IS NULL)
        ON CONFLICT(session_id, guid) DO NOTHING`;
    const { current, history } = yield* readBookmark(messages);
    let last = current;
    const fromPreviousRelationship = (conversation: Conversation, row: IncomingMessage) =>
      Effect.map(
        sql`SELECT 1 FROM send WHERE handle = ${row.handle} AND conversation_id != ${conversation.id}
        AND (guid = ${row.guid} OR (guid IS NULL AND content = ${row.text}
          AND recorded_at <= ${row.createdAt} AND state IN ('recorded', 'uncertain'))) LIMIT 1`,
        (rows) => rows.length > 0,
      );
    const outgoing = (row: IncomingMessage) =>
      Effect.gen(function* () {
        if (!reconcile) return;
        const conversation = yield* byHandle(row.handle);
        if (!conversation) return;
        yield* admit(
          conversation,
          Effect.gen(function* () {
            if (yield* fromPreviousRelationship(conversation, row)) return;
            const matched = yield* reconcile(conversation, row);
            const status = yield* messages.sendStatus(row.guid);
            if (matched || status === "failed") return;
            if (status === "sent" || status === "delivered")
              yield* sent(conversation, row.createdAt);
            const seen =
              yield* sql`SELECT guid FROM intake_seen WHERE session_id = ${conversation.sessionID} AND guid = ${row.guid}`;
            if (seen.length) return;
            yield* arriving(conversation.sessionID, promptID(conversation.sessionID, row.guid));
            yield* prompt(
              conversation.sessionID,
              promptID(conversation.sessionID, row.guid),
              sentByYou(row.text, row.createdAt, timeZone(conversation.personaID)),
            );
            yield* markSeen(conversation.sessionID, row.guid);
            signal(conversation);
          }),
        );
      });
    const target = (row: IncomingMessage, guid: string) =>
      Effect.map(messages.recent(row.handle, 0, { guid, limit: 1 }), (rows) => {
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
            const image = yield* messages.image(attachment);
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
        if (yield* fromPreviousRelationship(conversation, row)) return false;
        if ((yield* messages.sendStatus(row.guid)) === "failed") return false;
        if (seen) return true;
        yield* replayPrompt(
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
        const started = yield* sql<{ startedAt: number }>`SELECT started_at AS startedAt
          FROM conversation WHERE id = ${conversation.id}`;
        const key = `replay:${conversation.sessionID}`;
        const [saved] = yield* sql<{
          payload: string;
        }>`SELECT payload FROM application_checkpoint WHERE name = ${key}`;
        let progress = saved
          ? Schema.decodeUnknownSync(ReplayProgress)(saved.payload)
          : {
              cursor: 0,
              previous: null,
            };
        const checkpoint =
          () => sql`INSERT INTO application_checkpoint(name, payload) VALUES (${key},
          ${Schema.encodeSync(ReplayProgress)(progress)})
          ON CONFLICT(name) DO UPDATE SET payload = excluded.payload`;
        const replayRow = (row: IncomingMessage) =>
          Effect.gen(function* () {
            if (
              row.tapback?.added === false ||
              (yield* byHandle(conversation.handle))?.sessionID !== conversation.sessionID ||
              (yield* beforeReset(row))
            )
              return;
            const admitted = yield* sql`SELECT 1 WHERE EXISTS (
              SELECT 1 FROM intake_seen WHERE session_id =
                (SELECT replay_source_session_id FROM conversation WHERE id = ${conversation.id})
                AND guid = ${row.guid}) OR EXISTS (
              SELECT 1 FROM send WHERE conversation_id = ${conversation.id} AND guid = ${row.guid})`;
            if (!admitted.length) return;
            const seen =
              yield* sql`SELECT 1 FROM intake_seen WHERE session_id = ${conversation.sessionID}
              AND guid = ${row.guid}`;
            if (row.fromMe) {
              if (!(yield* replayOutgoing(conversation, row, seen.length > 0))) return;
            } else {
              yield* changes.remember(conversation, row);
              if (!seen.length) {
                const rendered = yield* content(
                  row,
                  progress.previous,
                  timeZone(conversation.personaID),
                );
                yield* replayPrompt(
                  conversation.sessionID,
                  promptID(conversation.sessionID, row.guid),
                  rendered.text,
                  rendered.files,
                );
              }
              progress = {
                ...progress,
                previous: row.createdAt,
              };
            }
            yield* markSeen(conversation.sessionID, row.guid);
          });
        for (;;) {
          const rows = yield* messages.recent(conversation.handle, started[0]!.startedAt, {
            after: progress.cursor,
            limit: 100,
          });
          if (!rows.length) break;
          for (const row of rows) {
            if (!(yield* claimWork)) {
              yield* checkpoint();
              yield* Effect.fail(new DeferredWork());
            }
            yield* replayRow(row);
            progress = { ...progress, cursor: row.id };
          }
          if (rows.length < 100) break;
          yield* checkpoint();
        }
        yield* sql`DELETE FROM application_checkpoint WHERE name = ${key}`;
      });
    const predatesRelationship = (conversation: Conversation, row: IncomingMessage) =>
      sql`SELECT 1 FROM conversation WHERE id = ${conversation.id} AND started_at > ${row.createdAt}
        AND EXISTS(SELECT 1 FROM conversation old WHERE old.user_id = conversation.user_id AND old.ended_at IS NOT NULL)`.pipe(
        Effect.map((rows) => rows.length > 0),
      );
    const receive = (row: IncomingMessage) =>
      Effect.gen(function* () {
        if (row.tapback && !row.tapback.added) {
          return;
        }
        yield* reset(row);
        if (yield* beforeReset(row)) {
          return;
        }
        if (ensure) yield* ensure(row.handle);
        if (row.fromMe) {
          yield* outgoing(row);
          return;
        }
        const conversation = yield* byHandle(row.handle);
        if (conversation) {
          yield* admit(
            conversation,
            Effect.gen(function* () {
              if (yield* predatesRelationship(conversation, row)) return;
              const seen =
                yield* sql`SELECT guid FROM intake_seen WHERE session_id = ${conversation.sessionID} AND guid = ${row.guid}`;
              if (seen.length) {
                return;
              }
              const earlier = yield* sql<{
                date: number | null;
              }>`SELECT last_received_at AS date FROM conversation WHERE id = ${conversation.id}`;
              yield* arriving(conversation.sessionID, promptID(conversation.sessionID, row.guid));
              const rendered = yield* content(
                row,
                earlier[0]!.date,
                timeZone(conversation.personaID),
              );
              yield* prompt(
                conversation.sessionID,
                promptID(conversation.sessionID, row.guid),
                rendered.text,
                rendered.files,
              );
              yield* Effect.gen(function* () {
                const active = yield* sql`SELECT 1 FROM conversation WHERE id = ${conversation.id}
                  AND session_id = ${conversation.sessionID} AND ended_at IS NULL`;
                if (!active.length) return;
                yield* changes.remember(conversation, row);
                yield* markSeen(conversation.sessionID, row.guid);
                yield* sql`UPDATE conversation SET last_received_at = ${row.createdAt}, first_received_at = COALESCE(first_received_at, ${row.createdAt}) WHERE id = ${conversation.id}`;
                yield* sql`UPDATE user SET replied_at = COALESCE(replied_at, ${row.createdAt}) WHERE id =
                (SELECT user_id FROM conversation WHERE id = ${conversation.id})`;
                yield* received(conversation, row.createdAt);
              }).pipe(sql.withTransaction);
              signal(conversation);
            }),
          );
          return;
        }
      });
    const poll = Effect.gen(function* () {
      const tail = yield* messages.after(Math.max(0, last.rowID - 1), 101);
      const replaced =
        last.rowID > 0 && tail.find((row) => row.id === last.rowID)?.createdAt !== last.date;
      const boundary = last.date;
      const rows = replaced ? yield* messages.after(0) : tail;
      const batch = rows
        .filter((row) =>
          replaced ? row.createdAt >= boundary : row.id > last.rowID || row.createdAt > last.date,
        )
        .slice(0, 100);
      const acknowledged = yield* queue.enqueue(batch);
      if (acknowledged) {
        last = { rowID: acknowledged.id, date: acknowledged.createdAt };
      }
      for (const row of batch) {
        if (row.fromMe || row.tapback?.added === false) continue;
        if (yield* beforeReset(row)) continue;
        const conversation = yield* byHandle(row.handle);
        if (conversation && !(yield* predatesRelationship(conversation, row)))
          yield* arriving(conversation.sessionID, promptID(conversation.sessionID, row.guid));
      }
      if (batch.length === 100)
        yield* scheduleWork("intake", Date.now()).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
    });
    // Live notifications and periodic polls share the admission cursor. Edit
    // observation stays outside this lock because it can itself deliver a reset.
    const observe = Effect.all([pollLock.withPermit(poll), changes.poll], {
      concurrency: "unbounded",
    });
    const heartbeat = observe.pipe(
      Effect.andThen(
        Effect.raceFirst(
          drainLock.withPermit(
            queue.drain(receive, (handle, entry) =>
              Effect.gen(function* () {
                if (ensure) yield* ensure(handle);
                const conversation = yield* byHandle(handle);
                if (conversation?.sessionID !== entry.sessionID) return;
                yield* admit(conversation, prompt(entry.sessionID, entry.id, entry.text));
              }),
            ),
          ),
          // Admission can wait on media or the remote executor. Keep observing
          // arrivals during that wait, even when the caller is the single DO alarm.
          observeWhileWaiting(observe, () => last.rowID),
        ),
      ),
    );
    if (startImmediately) yield* heartbeat;
    return {
      resetPending: Effect.forEach(
        history.filter((row) => row.id > current.rowID || row.createdAt > current.date),
        reset,
      ).pipe(Effect.asVoid),
      replay: (conversation: Conversation) =>
        replay(conversation).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      poll: heartbeat.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      onNew: (listener: (conversation: Conversation) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  });
