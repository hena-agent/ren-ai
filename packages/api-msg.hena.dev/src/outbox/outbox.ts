import { Clock, Effect, Random, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Conversation } from "../conversations/conversations.ts";
import type { Gestures } from "../gestures/gestures.ts";
import type { Messages } from "../messages/messages.ts";
import { notReacted, notSent, sent } from "../transcript/transcript.ts";

export const tapbacks = ["love", "like", "dislike", "laugh", "emphasis", "question"] as const;
export type Tapback = (typeof tapbacks)[number];

interface SendRow {
  readonly id: number;
  readonly state: string;
}

export const outbox = (messages: Messages, gestures: Gestures) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      notice: (handle: string, text: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* sql`INSERT INTO send (handle, kind, content, state, recorded_at, updated_at)
            VALUES (${handle}, 'notice', ${text}, 'recorded', ${now}, ${now})`;
          const [record] = yield* sql<{ id: number }>`SELECT id FROM send
            WHERE handle = ${handle} AND kind = 'notice' ORDER BY id DESC LIMIT 1`;
          const id = record!.id;
          const outcome = yield* Effect.result(messages.sendText(handle, text));
          if (Result.isFailure(outcome)) {
            yield* sql`UPDATE send SET state = 'uncertain', updated_at = ${yield* Clock.currentTimeMillis}
              WHERE id = ${id}`;
          } else {
            yield* sql`UPDATE send SET state = 'uncertain', guid = ${outcome.success.guid}, updated_at = ${yield* Clock.currentTimeMillis}
              WHERE id = ${id}`;
          }
        }),
      react: (conversation: Conversation, tapback: Tapback, callID: string, seenGUID?: string) =>
        Effect.gen(function* () {
          const existing =
            yield* sql<SendRow>`SELECT id, state FROM send WHERE conversation_id = ${conversation.id} AND tool_call_id = ${callID}`;
          if (existing.length) return notReacted("this call was already recorded");
          const pending =
            yield* sql<SendRow>`SELECT id, state FROM send WHERE conversation_id = ${conversation.id} AND state IN ('recorded', 'uncertain') LIMIT 1`;
          if (pending.length) return notReacted("an earlier send is still in doubt");
          const rows = yield* messages.after(0);
          const latest = rows
            .filter((row) => row.handle === conversation.handle && !row.fromMe)
            .at(-1);
          if (!seenGUID || latest?.guid !== seenGUID)
            return notReacted("a newer message arrived, or there is no message to react to");
          const attempted =
            yield* sql<SendRow>`SELECT id, state FROM send WHERE conversation_id = ${conversation.id}
            AND kind = 'tapback' AND content = ${tapback} AND target_guid = ${seenGUID} LIMIT 1`;
          if (attempted.length)
            return notReacted("this tapback was already attempted on that message");
          const now = yield* Clock.currentTimeMillis;
          yield* sql`INSERT INTO send (handle, conversation_id, kind, content, tool_call_id, state, target_guid, recorded_at, updated_at)
            VALUES (${conversation.handle}, ${conversation.id}, 'tapback', ${tapback}, ${callID}, 'recorded', ${seenGUID}, ${now}, ${now})`;
          const outcome = yield* Effect.result(gestures.react(conversation.handle, tapback));
          const state = Result.isFailure(outcome) ? "failed" : "sent";
          yield* sql`UPDATE send SET state = ${state}, updated_at = ${yield* Clock.currentTimeMillis}
            WHERE conversation_id = ${conversation.id} AND tool_call_id = ${callID}`;
          if (Result.isFailure(outcome)) return notReacted(outcome.failure.message);
          return `reacted ${tapback}`;
        }),
      send: (conversation: Conversation, text: string, callID: string) =>
        Effect.gen(function* () {
          const existing =
            yield* sql<SendRow>`SELECT id, state FROM send WHERE conversation_id = ${conversation.id} AND tool_call_id = ${callID}`;
          if (existing.length) return notSent("this call was already recorded");
          const pending =
            yield* sql<SendRow>`SELECT id, state FROM send WHERE conversation_id = ${conversation.id} AND state IN ('recorded', 'uncertain') LIMIT 1`;
          if (pending.length) return notSent("an earlier send is still in doubt");
          const extra = yield* Random.nextBetween(1000, 2000);
          const duration = Math.min(15000, text.length * 250 + extra);
          // UI failures do not stop imsg sends; a new inbound message does.
          const ready = yield* gestures
            .typing(conversation.handle, duration)
            .pipe(Effect.catch(() => Effect.succeed(true)));
          if (!ready) return notSent("a new message arrived");
          const now = yield* Clock.currentTimeMillis;
          yield* sql`INSERT INTO send (handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
            VALUES (${conversation.handle}, ${conversation.id}, 'text', ${text}, ${callID}, 'recorded', ${now}, ${now})`;
          const rows =
            yield* sql<SendRow>`SELECT id, state FROM send WHERE conversation_id = ${conversation.id} AND tool_call_id = ${callID}`;
          const id = rows[0]!.id;
          const outcome = yield* Effect.result(messages.sendText(conversation.handle, text));
          if (Result.isFailure(outcome)) {
            yield* sql`UPDATE send SET state = 'uncertain', updated_at = ${yield* Clock.currentTimeMillis} WHERE id = ${id}`;
            return notSent("send in doubt");
          }
          yield* sql`UPDATE send SET state = 'sent', guid = ${outcome.success.guid}, updated_at = ${yield* Clock.currentTimeMillis} WHERE id = ${id}`;
          return sent();
        }),
    };
  });
