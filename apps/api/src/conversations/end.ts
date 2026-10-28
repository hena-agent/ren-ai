import { randomUUID } from "node:crypto";
import { Clock, Effect, Result, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { messagingToolDefinitions } from "@ren-ai/plugin-application";
import type { Gestures, Messages } from "@ren-ai/imsg";
import type { Persona } from "@ren-ai/personas";
import { outbox } from "../outbox/outbox.ts";
import type { Conversation, conversations } from "./conversations.ts";
import { withLifecycle } from "./lifecycle.ts";
import { contactCause, contactLog, type ContactLog } from "../discovery/diagnostics.ts";
import { recoverEnding } from "./recover.ts";
import type { ConversationRecovery } from "@ren-ai/onboarding";
import { recordEnding } from "./ending-record.ts";
import { endingNotifications, type NotificationTransport } from "./notifications.ts";

interface Ending extends Conversation {
  readonly callID: string;
  readonly farewell: string;
  readonly notice: string;
  readonly farewellAttempt: number;
  readonly noticeAttempt: number;
  readonly farewellPending: number;
  readonly noticePending: number;
  readonly farewellUncertain: number;
}

const pendingParts = (row: Ending) =>
  (row.farewellUncertain
    ? (["notice", "farewell"] as const)
    : (["farewell", "notice"] as const)
  ).filter((part) => (part === "notice" ? row.noticePending : row.farewellPending));

/** Relationship endings are separate from service-wide blocking. Their private sessions remain intact. */
export const conversationEndings = Effect.fnUntraced(function* (
  directory: Effect.Success<typeof conversations>,
  sends: Effect.Success<ReturnType<typeof outbox>>,
  messages: Messages & NotificationTransport,
  gestures: Gestures,
  personas: ReadonlyMap<string, Persona>,
  log: ContactLog = contactLog,
) {
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);
  const notifications = yield* endingNotifications(messages, log);
  const available = (conversation: Conversation) =>
    Effect.map(
      sql`SELECT 1 FROM conversation c JOIN conversation_end e ON e.conversation_id = c.id
      JOIN user u ON u.id = c.user_id WHERE c.id = ${conversation.id}
      AND c.session_id = ${conversation.sessionID} AND e.consumed_at IS NULL AND c.ended_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM conversation a WHERE a.user_id = u.id AND a.ended_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM blocked WHERE handle = u.handle)
      AND NOT EXISTS (SELECT 1 FROM removal WHERE handle = u.handle)`,
      (rows) => rows.length > 0,
    );
  const closing = yield* outbox(messages, gestures, personas, available, undefined, {
    reportLate: false,
    typing: false,
  });
  const deliver = (row: Ending, part: "farewell" | "notice") =>
    Effect.gen(function* () {
      const attempt = part === "notice" ? row.noticeAttempt : row.farewellAttempt;
      const callID = `${row.callID}:${part}:${attempt}`;
      const transport = part === "notice" ? notifications : closing;
      let state = yield* transport.delivery(row, callID);
      if (state === undefined) {
        yield* transport.send(row, row[part], callID);
        state = yield* transport.delivery(row, callID);
      }
      return state;
    });
  const finish = Effect.fnUntraced(function* (row: Ending) {
    for (const part of pendingParts(row)) {
      const state = yield* deliver(row, part).pipe(
        Effect.catch((cause) => {
          log({
            requestId: randomUUID(),
            operation: "conversation.end",
            stage: `ending.${part}`,
            outcome: "failed",
            level: "error",
            personaId: row.personaID,
            durationMs: 0,
            ...contactCause(cause),
          });
          return Effect.succeed(undefined);
        }),
      );
      if (state === "failed" || state === "not_sent" || state === "sent" || state === "delivered") {
        if (part === "notice")
          yield* sql`UPDATE conversation_end SET notice_pending = 0 WHERE conversation_id = ${row.id} AND notice_attempt = ${row.noticeAttempt}`;
        else
          yield* sql`UPDATE conversation_end SET farewell_pending = 0 WHERE conversation_id = ${row.id} AND farewell_attempt = ${row.farewellAttempt}`;
        const failed = state === "failed" || state === "not_sent";
        log({
          requestId: randomUUID(),
          operation: "conversation.end",
          stage: `ending.${part}`,
          outcome: failed ? "failed" : "completed",
          level: failed ? "error" : "info",
          code: `ending_${state}`,
          personaId: row.personaID,
          durationMs: 0,
        });
      }
    }
  });
  const tick = lock.withPermit(
    Effect.gen(function* () {
      const rows = yield* sql<Ending>`SELECT c.id, u.handle, c.persona_id AS personaID,
      c.session_id AS sessionID, e.call_id AS callID, e.farewell, e.notice,
      e.farewell_attempt AS farewellAttempt, e.notice_attempt AS noticeAttempt,
      e.farewell_pending AS farewellPending, e.notice_pending AS noticePending,
      EXISTS(SELECT 1 FROM send s WHERE s.conversation_id = c.id
        AND s.tool_call_id = e.call_id || ':farewell:' || e.farewell_attempt
        AND s.state IN ('recorded','uncertain')) AS farewellUncertain
      FROM conversation_end e JOIN conversation c ON c.id = e.conversation_id
      JOIN user u ON u.id = c.user_id WHERE (e.farewell_pending = 1 OR e.notice_pending = 1)
      AND e.consumed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM blocked WHERE handle = u.handle)
      AND NOT EXISTS (SELECT 1 FROM removal WHERE handle = u.handle)
      AND NOT EXISTS (SELECT 1 FROM conversation a WHERE a.user_id = u.id AND a.ended_at IS NULL)
      ORDER BY e.last_checked, c.id LIMIT 1`;
      for (const row of rows) {
        const requestId = randomUUID();
        const start = performance.now();
        yield* sql`UPDATE conversation_end SET last_checked = MAX(${yield* Clock.currentTimeMillis},
            (SELECT MAX(last_checked) + 1 FROM conversation_end
              WHERE (farewell_pending = 1 OR notice_pending = 1) AND consumed_at IS NULL)) WHERE conversation_id = ${row.id}`;
        const result = yield* Effect.result(finish(row).pipe(Effect.timeout("3 seconds")));
        if (Result.isFailure(result))
          log({
            requestId,
            operation: "conversation.end",
            stage: "ending.delivery",
            code: "ending_delivery_failed",
            outcome: "failed",
            level: "error",
            personaId: row.personaID,
            durationMs: performance.now() - start,
            ...contactCause(result.failure),
          });
      }
    }),
  );
  const end = (sessionID: string, farewell: string, callID: string) =>
    Effect.gen(function* () {
      const requestId = randomUUID();
      const start = performance.now();
      let stage = "ending.input";
      let personaId: string | undefined;
      const result = yield* Effect.result(
        Effect.gen(function* () {
          const validation = messagingToolDefinitions.end_conversation.input["~standard"].validate({
            farewell,
          });
          const validated = yield* Effect.promise(() => Promise.resolve(validation));
          if (validated.issues || !farewell.trim())
            return yield* Effect.fail(new Error("Invalid farewell"));
          stage = "ending.binding";
          const [previous] =
            yield* sql`SELECT 1 FROM conversation_end e JOIN conversation c ON c.id = e.conversation_id
        WHERE c.session_id = ${sessionID}`;
          if (previous) return "Conversation already ended";
          const conversation = yield* directory.bySession(sessionID);
          if (!conversation || !(yield* directory.active(conversation)))
            return yield* Effect.fail(new Error("No active Conversation for session"));
          personaId = conversation.personaID;
          stage = "ending.commit";
          yield* sends.exclusive(
            conversation,
            withLifecycle(
              Effect.gen(function* () {
                if (!(yield* directory.active(conversation)))
                  yield* Effect.fail(new Error("Conversation changed before ending"));
                yield* recordEnding(conversation, farewell, callID, "persona").pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                );
              }).pipe(sql.withTransaction),
            ),
          );
          return "Conversation ended. Farewell and Ren AI reselection notice are queued. Do not send further messages.";
        }),
      );
      const failed = Result.isFailure(result);
      log({
        requestId,
        operation: "conversation.end",
        stage,
        outcome: failed ? "failed" : "completed",
        level: failed ? (stage === "ending.commit" ? "error" : "warn") : "info",
        durationMs: performance.now() - start,
        ...(failed && contactCause(result.failure)),
        ...(personaId && { personaId }),
      });
      if (failed)
        return yield* Effect.fail(
          new Error(`Conversation ending failed; request ID: ${requestId}`, {
            cause: result.failure,
          }),
        );
      return result.success;
    });
  return {
    end,
    tick,
    recover: (input: typeof ConversationRecovery.Type) =>
      lock.withPermit(
        recoverEnding(input, (input.action === "notice" ? notifications : closing).delivery).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          sql.withTransaction,
          Effect.timeout("3 seconds"),
        ),
      ),
    observe: (id: number, requestId: string = randomUUID()) =>
      Effect.gen(function* () {
        const [row] = yield* sql<
          Pick<
            Ending,
            | "id"
            | "handle"
            | "personaID"
            | "sessionID"
            | "callID"
            | "farewellAttempt"
            | "noticeAttempt"
          >
        >`SELECT c.id, u.handle, c.persona_id AS personaID, c.session_id AS sessionID,
          e.call_id AS callID, e.farewell_attempt AS farewellAttempt, e.notice_attempt AS noticeAttempt
          FROM conversation c JOIN user u ON u.id = c.user_id JOIN conversation_end e ON e.conversation_id = c.id WHERE c.id = ${id}`;
        if (!row) return;
        for (const part of ["farewell", "notice"] as const) {
          const attempt = part === "notice" ? row.noticeAttempt : row.farewellAttempt;
          yield* (part === "notice" ? notifications : closing)
            .delivery(row, `${row.callID}:${part}:${attempt}`)
            .pipe(
              Effect.catch((cause) =>
                Effect.sync(() =>
                  log({
                    requestId,
                    operation: "conversation.end",
                    stage: `ending.observe.${part}`,
                    outcome: "failed",
                    level: "error",
                    personaId: row.personaID,
                    durationMs: 0,
                    ...contactCause(cause),
                  }),
                ),
              ),
            );
        }
      }),
  };
});
