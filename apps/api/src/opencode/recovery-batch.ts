import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { Conversation } from "../conversations/conversations.ts";
import { workBatchSize } from "../work-budget.ts";

/** Bound storage reads before inspecting remote sessions; the cursor survives actor replacement. */
export const recoveryBatch = (sessionIDs?: readonly string[]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const limit = Math.min(20, yield* workBatchSize);
    const active = sql`c.ended_at IS NULL AND NOT EXISTS (SELECT 1 FROM blocked WHERE handle = u.handle)`;
    const columns = sql`c.id, u.handle, c.persona_id AS personaID, c.session_id AS sessionID`;
    if (sessionIDs) {
      const selected =
        yield* sql<Conversation>`SELECT ${columns} FROM conversation c JOIN user u ON u.id = c.user_id
      WHERE c.session_id IN ${sql.in(sessionIDs)} AND ${active}`;
      return { selected, priority: new Set(sessionIDs) };
    }
    const failed = yield* sql<Conversation>`SELECT ${columns} FROM failed_turn f
    JOIN conversation c ON c.session_id = f.session_id JOIN user u ON u.id = c.user_id
    WHERE ${active} ORDER BY f.retry_at, f.session_id LIMIT ${Math.min(10, Math.floor(limit / 2))}`;
    const priority = new Set(failed.map((row) => row.sessionID));
    const [scan] = yield* sql<{
      conversationID: number;
    }>`SELECT conversation_id AS conversationID FROM recovery_scan WHERE id = 1`;
    const cursor = scan?.conversationID ?? 0;
    const budget = limit - failed.length;
    const after =
      yield* sql<Conversation>`SELECT ${columns} FROM conversation c JOIN user u ON u.id = c.user_id
    WHERE c.id > ${cursor} AND c.session_id NOT IN ${sql.in([...priority])} AND ${active} ORDER BY c.id LIMIT ${budget}`;
    const before =
      after.length < budget
        ? yield* sql<Conversation>`SELECT ${columns} FROM conversation c JOIN user u ON u.id = c.user_id
      WHERE c.id <= ${cursor} AND c.session_id NOT IN ${sql.in([...priority])} AND ${active}
      ORDER BY c.id LIMIT ${budget - after.length}`
        : [];
    return { selected: [...failed, ...after, ...before], priority };
  });
