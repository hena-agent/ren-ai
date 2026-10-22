import { Effect, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { remoteMessages } from "@ren-ai/imsg/client";
import type { Conversation } from "./conversations.ts";
import { contactCause, contactLog, type ContactLog } from "../discovery/diagnostics.ts";

export type NotificationTransport = Pick<
  Effect.Success<ReturnType<typeof remoteMessages>>,
  "notify" | "notificationStatus"
>;

/** A separate ledger keeps service notifications out of persona history and send recovery. */
export const endingNotifications = (
  transport: NotificationTransport,
  log: ContactLog = contactLog,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const delivery = (conversation: Conversation, callID: string) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ state: string; guid: string | null }>`SELECT state, guid
          FROM ending_notification WHERE conversation_id = ${conversation.id} AND call_id = ${callID}`;
        if (!row) return undefined;
        if (row.state === "failed" || row.state === "delivered" || !row.guid) return row.state;
        const status = yield* transport.notificationStatus(row.guid);
        if (status.state === "pending") return row.state;
        yield* sql`UPDATE ending_notification SET state = ${status.state}
          WHERE conversation_id = ${conversation.id} AND call_id = ${callID}`;
        if (status.state === "failed")
          log({
            requestId: crypto.randomUUID(),
            operation: "conversation.end",
            stage: "notification.status",
            outcome: "failed",
            level: "error",
            code: `IMSG_SEND_${status.error}`,
            personaId: conversation.personaID,
            durationMs: 0,
          });
        return status.state;
      });
    return {
      delivery,
      send: (conversation: Conversation, text: string, callID: string) =>
        Effect.gen(function* () {
          // Commit uncertainty before the RPC: a missing acknowledgement never authorizes a resend.
          const claimed =
            yield* sql`INSERT INTO ending_notification (conversation_id, call_id, state)
            SELECT c.id, ${callID}, 'uncertain' FROM conversation c
            JOIN conversation_end e ON e.conversation_id = c.id JOIN user u ON u.id = c.user_id
            WHERE c.id = ${conversation.id} AND c.session_id = ${conversation.sessionID}
            AND c.ended_at IS NOT NULL AND e.consumed_at IS NULL AND e.notice_pending = 1
            AND ${callID} = e.call_id || ':notice:' || e.notice_attempt AND e.notice = ${text}
            AND NOT EXISTS (SELECT 1 FROM conversation a WHERE a.user_id = u.id AND a.ended_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM blocked WHERE handle = u.handle)
            AND NOT EXISTS (SELECT 1 FROM removal WHERE handle = u.handle)
            ON CONFLICT DO NOTHING RETURNING conversation_id`;
          if (!claimed.length) return;
          const requestId = crypto.randomUUID();
          const started = performance.now();
          let stage = "notification.submit";
          const result = yield* Effect.result(
            Effect.gen(function* () {
              const submitted = yield* transport.notify(conversation.handle, text);
              stage = "notification.commit";
              yield* sql`UPDATE ending_notification SET guid = ${submitted.guid}
              WHERE conversation_id = ${conversation.id} AND call_id = ${callID}`;
              return submitted.requestId;
            }),
          );
          const failed = Result.isFailure(result);
          log({
            requestId,
            operation: "conversation.end",
            stage: failed ? stage : "notification.complete",
            outcome: failed ? "failed" : "completed",
            level: failed ? "error" : "info",
            personaId: conversation.personaID,
            durationMs: performance.now() - started,
            ...(failed ? contactCause(result.failure) : { operationId: result.success }),
          });
        }),
    };
  });
