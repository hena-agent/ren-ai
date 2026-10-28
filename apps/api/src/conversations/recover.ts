import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { ConversationRecovery } from "@ren-ai/onboarding";
import type { Conversation } from "./conversations.ts";

type Delivery = (
  conversation: Conversation,
  callID: string,
) => Effect.Effect<string | undefined, Error>;
export class RecoveryConflict extends Error {}
type Ending = Conversation & {
  callID: string;
  farewellAttempt: number;
  noticeAttempt: number;
  consumedAt: number | null;
};

const queueDelivery = (input: typeof ConversationRecovery.Type, row: Ending, delivery: Delivery) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (row.consumedAt !== null)
      return yield* Effect.fail(new RecoveryConflict("User already moved to another relationship"));
    const attempt = input.action === "notice" ? row.noticeAttempt : row.farewellAttempt;
    const state = yield* delivery(row, `${row.callID}:${input.action}:${attempt}`);
    if (state === "recorded" || state === "uncertain")
      return yield* Effect.fail(
        new RecoveryConflict("Delivery remains uncertain; check status first"),
      );
    if (input.action === "farewell" && state !== "failed" && state !== "not_sent")
      return yield* Effect.fail(
        new RecoveryConflict("Only a confirmed failed farewell may be retried"),
      );
    const next = state === undefined ? attempt : attempt + 1;
    if (input.action === "notice")
      yield* sql`UPDATE conversation_end SET notice_attempt = ${next}, notice_pending = 1 WHERE conversation_id = ${input.id}`;
    else
      yield* sql`UPDATE conversation_end SET farewell_attempt = ${next}, farewell_pending = 1 WHERE conversation_id = ${input.id}`;
    return undefined;
  });

/** Operator actions are deduplicated separately from paid/model tool calls. */
export const recoverEnding = (input: typeof ConversationRecovery.Type, delivery: Delivery) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [prior] = yield* sql<{
      id: number;
      action: string;
    }>`SELECT conversation_id AS id, action FROM conversation_recovery WHERE request_id = ${input.requestId}`;
    if (prior) {
      if (prior.id !== input.id || prior.action !== input.action)
        return yield* Effect.fail(new RecoveryConflict("Recovery request conflict"));
      return undefined;
    }
    const [row] = yield* sql<Ending>`SELECT
    c.id, c.session_id AS sessionID, c.persona_id AS personaID, u.handle, e.call_id AS callID,
    e.farewell_attempt AS farewellAttempt, e.notice_attempt AS noticeAttempt, e.consumed_at AS consumedAt
    FROM conversation c JOIN user u ON u.id = c.user_id JOIN conversation_end e ON e.conversation_id = c.id
    WHERE c.id = ${input.id} AND c.ended_at IS NOT NULL`;
    if (!row) return yield* Effect.fail(new RecoveryConflict("No ended Conversation"));
    if (input.action === "stop") {
      yield* sql`UPDATE conversation_end SET stopped_at = NULL WHERE conversation_id = ${input.id}`;
    } else yield* queueDelivery(input, row, delivery);
    yield* sql`INSERT INTO conversation_recovery VALUES (${input.requestId}, ${input.id}, ${input.action}, ${yield* Clock.currentTimeMillis})`;
    return undefined;
  });
