import { Clock, Effect, Result, Semaphore } from "effect";
import { Session } from "@opencode/schema/session";
import { SqlClient } from "effect/unstable/sql";
import { randomUUID } from "node:crypto";
import type { PersonaRuntime } from "../opencode/runtime.ts";
import { contactCause, contactLog, type ContactLog } from "../discovery/diagnostics.ts";

/** Never called from a tool executing inside the session being stopped. */
export const stopSession = (host: PersonaRuntime, sessionID: string) =>
  Effect.gen(function* () {
    const id = Session.ID.make(sessionID);
    yield* host.sessions.interrupt(id);
    for (const item of yield* host.sessions.inbox(id))
      yield* host.sessions.cancelInbox({ sessionID: id, inboxID: item.id });
    yield* host.sessions.wait(id);
    if ((yield* host.sessions.inbox(id)).length)
      yield* Effect.fail(new Error("Session still has pending work"));
  }).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void));

export const stoppedConversations = (host: PersonaRuntime, log: ContactLog = contactLog) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const lock = yield* Semaphore.make(1);
    const tick = lock.withPermit(
      Effect.gen(function* () {
        const [row] = yield* sql<{ id: number; sessionID: string; personaID: string }>`SELECT c.id,
      c.session_id AS sessionID, c.persona_id AS personaID FROM conversation c JOIN conversation_end e ON e.conversation_id = c.id
      WHERE c.ended_at IS NOT NULL AND e.stopped_at IS NULL ORDER BY e.stop_checked, c.id LIMIT 1`;
        if (!row) return;
        const requestId = randomUUID();
        const started = performance.now();
        yield* sql`UPDATE conversation_end SET stop_checked = (SELECT MAX(stop_checked) + 1 FROM conversation_end)
      WHERE conversation_id = ${row.id}`;
        const result = yield* Effect.result(
          host.sessions
            .writable(Session.ID.make(row.sessionID), false)
            .pipe(Effect.andThen(stopSession(host, row.sessionID)), Effect.timeout("5 seconds")),
        );
        if (Result.isSuccess(result))
          yield* sql`UPDATE conversation_end SET stopped_at = ${yield* Clock.currentTimeMillis} WHERE conversation_id = ${row.id}`;
        log({
          requestId,
          operation: "conversation.stop",
          stage: "session.stop",
          personaId: row.personaID,
          sessionId: row.sessionID,
          outcome: Result.isSuccess(result) ? "completed" : "failed",
          level: Result.isSuccess(result) ? "info" : "error",
          durationMs: performance.now() - started,
          ...(Result.isFailure(result) && contactCause(result.failure)),
        });
      }),
    );
    return { tick, resume: tick };
  });
