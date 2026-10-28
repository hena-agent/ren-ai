import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { Conversation } from "../conversations/conversations.ts";

export const photo = Buffer.from([255, 216, 255, 224, 1, 255, 217]).toString("base64");

export const takenPhoto = (conversation: Conversation, id: string, expiresAt?: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    yield* sql`INSERT INTO conversation_photo
      (id, conversation_id, session_id, call_id, state, reserved_at, taken_at, expires_at, includes_me)
      VALUES (${id}, ${conversation.id}, ${conversation.sessionID}, ${id}, 'taken',
        ${now}, ${now}, ${expiresAt ?? now + 3_600_000}, 1)`;
  });
