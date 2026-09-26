import { Clock, Effect, Random, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Conversation } from "../conversations/conversations.ts";
import type { Gestures } from "../gestures/gestures.ts";
import type { Messages } from "../messages/messages.ts";
import { notSent, sent } from "../transcript/transcript.ts";
import type { timing } from "../timing/timing.ts";

interface SendRow {
  readonly id: number;
  readonly state: string;
}

export const outbox = (messages: Messages, gestures: Gestures, pace?: ReturnType<typeof timing>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
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
          const type = gestures.typing(conversation.handle, duration).pipe(
            Effect.catch(() =>
              Effect.gen(function* () {
                const elapsed = (yield* Clock.currentTimeMillis) - typingStarted;
                yield* Effect.sleep(Math.max(0, duration - elapsed));
                return true;
              }),
            ),
          );
          const typingStarted = yield* Clock.currentTimeMillis;
          const ready = pace ? yield* pace.during(conversation.id, type) : yield* type;
          if (ready !== true) return notSent("a new message arrived");
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
