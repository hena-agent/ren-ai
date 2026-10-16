import { randomUUID } from "node:crypto";
import { Clock, Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { IncomingMessage } from "@ren-ai/imsg";
import { incomingMessage } from "@ren-ai/imsg/protocol";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";

const payload = Schema.fromJsonString(incomingMessage);

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
  const drain = (receive: (row: IncomingMessage) => Effect.Effect<void, Error>) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql<{
        id: number;
        handle: string;
        payload: string;
      }>`SELECT p.id, p.handle, p.payload
      FROM intake_pending p WHERE p.retry_at <= ${now}
      AND NOT EXISTS (SELECT 1 FROM intake_pending earlier
        WHERE earlier.handle = p.handle AND earlier.id < p.id AND earlier.retry_at > ${now})
      ORDER BY p.id LIMIT 100`;
      const groups = new Map<string, (typeof rows)[number][]>();
      for (const row of rows) {
        const group = groups.get(row.handle) ?? [];
        group.push(row);
        groups.set(row.handle, group);
      }
      yield* Effect.forEach(
        groups,
        ([handle, group]) =>
          Effect.gen(function* () {
            const started = yield* Clock.currentTimeMillis;
            const requestId = randomUUID();
            const result = yield* Effect.forEach(group.slice(0, 25), (row) =>
              Effect.gen(function* () {
                const message = yield* Schema.decodeUnknownEffect(payload)(row.payload);
                yield* receive(message).pipe(Effect.timeout("30 seconds"));
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
              yield* sql`UPDATE intake_pending SET retry_at = ${now + 30_000} WHERE handle = ${handle}`;
            } else contactLog({ ...fields, outcome: "completed", level: "info" });
          }),
        { concurrency: 4 },
      );
    });
  return { enqueue, drain };
});
