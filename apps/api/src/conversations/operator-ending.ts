import { Clock, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ConversationEnding } from "@ren-ai/onboarding";
import type { Conversation } from "./conversations.ts";
import { recordEnding } from "./ending-record.ts";
import { withLifecycle } from "./lifecycle.ts";
import { RecoveryConflict } from "./recover.ts";
import { scheduleWork } from "../scheduling.ts";

/** Fence by immutable Conversation ID, including rebuilding sessions and an unavailable Mac. */
export const operatorEnding = (input: typeof ConversationEnding.Type) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.gen(function* () {
      const [prior] = yield* sql<{
        id: number;
        action: string;
      }>`SELECT conversation_id AS id, action FROM conversation_recovery WHERE request_id = ${input.requestId}`;
      if (prior) {
        if (prior.id !== input.id || prior.action !== "end")
          return yield* Effect.fail(new RecoveryConflict("Ending request conflict"));
        return undefined;
      }
      const [row] = yield* sql<
        Conversation & { endedAt: number | null }
      >`SELECT c.id, c.session_id AS sessionID, c.persona_id AS personaID, u.handle, c.ended_at AS endedAt
      FROM conversation c JOIN user u ON u.id = c.user_id WHERE c.id = ${input.id} AND c.usage_key = ${input.key}`;
      if (!row) return yield* Effect.fail(new RecoveryConflict("No Conversation to end"));
      if (row.endedAt === null)
        yield* recordEnding(row, "", `operator_end_${input.requestId}`, "operator");
      yield* sql`INSERT INTO conversation_recovery VALUES (${input.requestId}, ${input.id}, 'end', ${yield* Clock.currentTimeMillis})`;
      yield* scheduleWork("endings", yield* Clock.currentTimeMillis);
      return undefined;
    }).pipe(sql.withTransaction, withLifecycle);
  });
