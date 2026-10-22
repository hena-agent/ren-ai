import { Session } from "@opencode/schema";
import { Cause, Clock, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { PersonaRuntime } from "./runtime.ts";
import type { Conversation, conversations } from "../conversations/conversations.ts";
import { claimWork, workBatchSize, workRequestId } from "../work-budget.ts";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";

type Directory = Effect.Success<typeof conversations>;
type Probe = { generation: number; attempts: number; resume: number; due: number };

const diagnose = (sessionID: string, stage: string, started: number, cause: Cause.Cause<Error>) =>
  Effect.gen(function* () {
    contactLog({
      requestId: yield* workRequestId,
      operation: "conversation.recovery",
      stage,
      sessionId: sessionID,
      outcome: "failed",
      level: "error",
      durationMs: (yield* Clock.currentTimeMillis) - started,
      ...contactCause(Cause.squash(cause)),
    });
  });

/** Resolve the global cap atomically with durable, bounded replay admission. No remote call in this transaction. */
export const releaseQuotaTurns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.gen(function* () {
    yield* sql`INSERT INTO application_work(name, due, resume) SELECT 'turn:' || session_id, ${now}, 1 FROM failed_turn
      WHERE quota = 1 AND review = 0 ON CONFLICT(name) DO UPDATE SET due = MIN(due, excluded.due), resume = 1, attempts = 0, generation = generation + 1`;
    yield* sql`DELETE FROM failed_turn WHERE quota = 1 AND review = 0`;
  }).pipe(sql.withTransaction);
});

export const turnWork = (
  host: PersonaRuntime,
  directory: Directory,
  reconcile: (conversation: Conversation, now: number) => Effect.Effect<void, Error>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const inspect = (conversation: Conversation, now: number) =>
      Effect.gen(function* () {
        const name = `turn:${conversation.sessionID}`;
        const [probe] =
          yield* sql<Probe>`SELECT generation, attempts, resume, due FROM application_work WHERE name = ${name}`;
        if (probe && (probe.resume || probe.due > now)) return;
        yield* directory.admit(conversation.sessionID, reconcile(conversation, now)).pipe(
          Effect.andThen(() =>
            Effect.gen(function* () {
              if (probe)
                yield* sql`DELETE FROM application_work WHERE name = ${name} AND generation = ${probe.generation}`;
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterrupts(cause)) return yield* Effect.failCause(cause);
              yield* diagnose(conversation.sessionID, "session.inspect", now, cause);
              const attempts = (probe?.attempts ?? 0) + 1;
              const due =
                (yield* Clock.currentTimeMillis) +
                Math.min(30_000 * 2 ** Math.min(attempts - 1, 4), 300_000);
              if (probe)
                yield* sql`UPDATE application_work SET due = ${due}, attempts = ${attempts}, generation = generation + 1 WHERE name = ${name} AND generation = ${probe.generation}`;
              else
                yield* sql`INSERT INTO application_work(name, due, attempts) VALUES (${name}, ${due}, ${attempts}) ON CONFLICT(name) DO NOTHING`;
              yield* sql`UPDATE failed_turn SET retry_at = MAX(retry_at, ${due}) WHERE session_id = ${conversation.sessionID}
                AND EXISTS (SELECT 1 FROM application_work WHERE name = ${name} AND due = ${due})`;
              return undefined;
            }),
          ),
        );
      });
    const resumes = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const limit = Math.min(20, yield* workBatchSize);
      const rows = yield* sql<{
        name: string;
        generation: number;
      }>`SELECT name, generation FROM application_work INDEXED BY work_resume_due
      WHERE resume = 1 AND due <= ${now} ORDER BY due, name LIMIT ${limit}`;
      for (const row of rows) {
        if (!(yield* claimWork)) break;
        const claimed =
          yield* sql`UPDATE application_work SET resume = 0, due = ${now + 30_000}, generation = generation + 1
        WHERE name = ${row.name} AND generation = ${row.generation} RETURNING name`;
        if (!claimed.length) continue;
        const sessionID = row.name.slice(5);
        const conversation = yield* directory.bySession(sessionID);
        if (!conversation) continue;
        yield* directory
          .admit(
            sessionID,
            Effect.gen(function* () {
              const sent =
                yield* sql`SELECT 1 FROM send WHERE conversation_id = ${conversation.id} AND kind IN ('text','tapback') LIMIT 1`;
              if (sent.length) yield* reconcile(conversation, now);
              else yield* host.retry(Session.ID.make(sessionID));
            }),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (Cause.hasInterrupts(cause)) return yield* Effect.failCause(cause);
                yield* diagnose(sessionID, "session.resume", now, cause);
                return undefined;
              }),
            ),
          );
        // The retry may already have reached a new terminal checkpoint. Inspect it
        // on the next wake instead of hiding a renewed quota failure for 30 seconds.
        yield* sql`UPDATE application_work SET due = ${now} WHERE name = ${row.name} AND generation = ${row.generation + 1}`;
      }
    });
    return { inspect, resumes };
  });
