import { randomUUID } from "node:crypto";
import { Clock, Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { IncomingMessage } from "@ren-ai/imsg";
import { incomingMessage } from "@ren-ai/imsg/protocol";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";
import type { Conversation } from "../conversations/conversations.ts";
import { claimWork, workBatchSize } from "../work-budget.ts";

const edit = Schema.Struct({
  type: Schema.Literal("edit"),
  sessionID: Schema.String,
  id: Schema.String,
  text: Schema.String,
});
const payload = Schema.fromJsonString(Schema.Union([incomingMessage, edit]));

/** Acknowledge Mac rows atomically with durable admission; failures block only their Handle. */
export const intakeQueue = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const enqueue = (rows: readonly IncomingMessage[]) =>
    Effect.gen(function* () {
      for (const row of rows)
        yield* sql`INSERT OR IGNORE INTO intake_pending (guid, handle, payload)
      VALUES (${row.guid}, ${row.handle}, ${JSON.stringify(row)})`;
      const last = rows.at(-1);
      if (last)
        yield* sql`UPDATE bookmark SET row_id = ${last.id}, date = ${last.createdAt} WHERE id = 1`;
      return last;
    }).pipe(sql.withTransaction);
  const enqueueEdit = (conversation: Conversation, id: string, text: string) =>
    sql`INSERT OR IGNORE INTO intake_pending (guid, handle, payload) VALUES
      (${id}, ${conversation.handle}, ${JSON.stringify({ type: "edit", sessionID: conversation.sessionID, id, text })})`.pipe(
      Effect.asVoid,
    );
  const drain = (
    receive: (row: IncomingMessage) => Effect.Effect<void, Error>,
    receiveEdit: (handle: string, entry: typeof edit.Type) => Effect.Effect<void, Error>,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const limit = yield* workBatchSize;
      const handles = yield* sql<{ handle: string }>`SELECT handle FROM intake_handle
        WHERE retry_at <= ${now} ORDER BY retry_at, head LIMIT ${limit}`;
      yield* Effect.forEach(
        handles,
        ({ handle }) =>
          Effect.gen(function* () {
            const group = yield* sql<{
              id: number;
              handle: string;
              payload: string;
            }>`SELECT id, handle, payload FROM intake_pending
              WHERE handle = ${handle} ORDER BY id LIMIT ${Math.min(25, limit)}`;
            const started = yield* Clock.currentTimeMillis;
            const requestId = randomUUID();
            const result = yield* Effect.forEach(group, (row) =>
              Effect.gen(function* () {
                if (!(yield* claimWork)) return;
                const message = yield* Schema.decodeUnknownEffect(payload)(row.payload);
                yield* (
                  "type" in message ? receiveEdit(row.handle, message) : receive(message)
                ).pipe(Effect.timeout("30 seconds"));
                yield* sql`DELETE FROM intake_pending WHERE id = ${row.id}`;
              }),
            ).pipe(Effect.result);
            const fields = {
              requestId,
              operation: "intake.admission",
              stage: "conversation.admit",
              durationMs: (yield* Clock.currentTimeMillis) - started,
            };
            if (Result.isFailure(result)) {
              contactLog({
                ...fields,
                outcome: "failed",
                level: "error",
                ...contactCause(result.failure),
              });
              yield* sql`UPDATE intake_pending SET retry_at = ${now + 30_000}
                WHERE id = (SELECT head FROM intake_handle WHERE handle = ${handle})`;
            } else contactLog({ ...fields, outcome: "completed", level: "info" });
          }),
        { concurrency: 4 },
      );
    });
  return { enqueue, enqueueEdit, drain };
});
