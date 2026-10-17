import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Clock, Effect, Result, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { messagingToolDefinitions } from "@ren-ai/plugin-application";
import type { Gestures, Messages } from "@ren-ai/imsg";
import type { Persona } from "@ren-ai/personas";
import { outbox } from "../outbox/outbox.ts";
import type { Conversation, conversations } from "./conversations.ts";
import { withLifecycle } from "./lifecycle.ts";
import { contactCause, contactLog, type ContactLog } from "../discovery/diagnostics.ts";
import { recoverEnding } from "./recover.ts";
import type { ConversationRecovery } from "@ren-ai/onboarding";

export const reselectionHash = (token: string) => createHash("sha256").update(token).digest("hex");

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

const notice = (locale: string, token: string) => {
  const link = `https://renai.im/#reselect=${token}`;
  const text =
    locale === "ko"
      ? "[Ren AI] 이 페르소나와의 관계가 종료되었습니다. 아래 링크에서 다른 페르소나를 선택할 수 있어요. 기존 iMessage 주소로 신청해 주세요. 선택 후 첫 연락까지 기다림이 있을 수 있습니다."
      : locale === "ja"
        ? "[Ren AI] このペルソナとの関係は終了しました。以下のリンクから別のペルソナを選べます。同じiMessageアドレスでお申し込みください。最初の連絡までお待ちいただく場合があります。"
        : "[Ren AI] This relationship has ended. You can choose another persona below using your existing iMessage address. There may be a wait before the first message.";
  return `${text}\n${link}`;
};

/** Relationship endings are separate from service-wide blocking. Their private sessions remain intact. */
export const conversationEndings = (
  directory: Effect.Success<typeof conversations>,
  sends: Effect.Success<ReturnType<typeof outbox>>,
  messages: Messages,
  gestures: Gestures,
  personas: ReadonlyMap<string, Persona>,
  log: ContactLog = contactLog,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const lock = yield* Semaphore.make(1);
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
        let state = yield* closing.delivery(row, callID);
        if (state === undefined) {
          yield* closing.send(row, row[part], callID);
          state = yield* closing.delivery(row, callID);
        }
        return state;
      });
    const finish = (row: Ending) =>
      Effect.gen(function* () {
        const parts = row.farewellUncertain
          ? (["notice", "farewell"] as const)
          : (["farewell", "notice"] as const);
        for (const part of parts) {
          if (!(part === "notice" ? row.noticePending : row.farewellPending)) continue;
          const state = yield* deliver(row, part);
          if (
            state === "failed" ||
            state === "not_sent" ||
            state === "sent" ||
            state === "delivered"
          ) {
            if (part === "notice")
              yield* sql`UPDATE conversation_end SET notice_pending = 0 WHERE conversation_id = ${row.id} AND notice_attempt = ${row.noticeAttempt}`;
            else
              yield* sql`UPDATE conversation_end SET farewell_pending = 0 WHERE conversation_id = ${row.id} AND farewell_attempt = ${row.farewellAttempt}`;
            log({
              requestId: randomUUID(),
              operation: "conversation.end",
              stage: `ending.${part}`,
              outcome: state === "failed" || state === "not_sent" ? "failed" : "completed",
              level: state === "failed" || state === "not_sent" ? "error" : "info",
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
            (SELECT MAX(last_checked) + 1 FROM conversation_end)) WHERE conversation_id = ${row.id}`;
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
            const validation = messagingToolDefinitions.end_conversation.input[
              "~standard"
            ].validate({ farewell });
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
                  const [user] = yield* sql<{
                    locale: string;
                  }>`SELECT locale FROM user WHERE handle = ${conversation.handle}`;
                  const token = randomBytes(32).toString("hex");
                  const now = yield* Clock.currentTimeMillis;
                  yield* sql`INSERT INTO conversation_end (conversation_id, call_id, farewell, notice, token_hash)
          VALUES (${conversation.id}, ${callID}, ${farewell}, ${notice(user!.locale, token)}, ${reselectionHash(token)})`;
                  yield* sql`UPDATE conversation SET ended_at = ${now} WHERE id = ${conversation.id}`;
                  yield* sql`DELETE FROM follow_up WHERE conversation_id = ${conversation.id}`;
                  yield* sql`DELETE FROM failed_turn WHERE session_id = ${sessionID}`;
                  yield* sql`DELETE FROM persona_assignment WHERE handle = ${conversation.handle}`;
                  yield* sql`UPDATE user SET persona_id = NULL WHERE handle = ${conversation.handle}`;
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
          recoverEnding(input, closing.delivery).pipe(
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
            yield* closing.delivery(row, `${row.callID}:${part}:${attempt}`).pipe(
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
