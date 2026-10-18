import type {
  DurableObjectStorage,
  SqlStorageCursor,
  SqlStorageValue,
} from "@cloudflare/workers-types";
import { fromPartial } from "@total-typescript/shoehorn";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { DateTime, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { ApplicationStore } from "../src/application-store.ts";
import { usageCollector } from "../src/usage/collect.ts";

export async function usageBudget(storage: DurableObjectStorage, store: ApplicationStore) {
  const time = DateTime.makeUnsafe(1000);
  const tokens = { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } };
  const session = fromPartial<Session.Info>({
    id: "ses_budget",
    time: { created: time, updated: time, idle: time },
    tokens,
    cost: 0,
  });
  const history = Array.from({ length: 100 }, (_, i) => [
    fromPartial<SessionMessage.User>({
      type: "user",
      id: `msg_user_${i}`,
      time: { created: time },
    }),
    fromPartial<SessionMessage.Assistant>({
      type: "assistant",
      id: `msg_assistant_${i}`,
      time: { created: time, completed: time },
      tokens,
      cost: 0,
    }),
    fromPartial<SessionMessage.Idle>({
      type: "idle",
      id: `msg_idle_${i}`,
      time: { created: time },
      outcome: "succeeded",
    }),
  ]).flat();
  await store.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO usage_session (session_id, conversation_id, conversation_key, persona_id)
      VALUES (${session.id}, 1, 'budget', 'fixture')`;
    }),
  );
  const exec = storage.sql.exec.bind(storage.sql);
  let cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  storage.sql.exec = <T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ) => {
    const cursor = exec<T>(query, ...bindings);
    cursors.push(cursor);
    return cursor;
  };
  const collect = async () => {
    cursors = [];
    // Recreate the collector to include the actor-replacement path.
    await store.run(
      Effect.gen(function* () {
        const collector = yield* usageCollector({
          get: () => Effect.succeed(session),
          messages: () => Effect.succeed({ data: history, cursor: {} }),
        });
        yield* collector.tick;
      }),
    );
    return {
      reads: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      writes: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0),
    };
  };
  try {
    const initial = await collect();
    const idle = await collect();
    history[1] = fromPartial<SessionMessage.Assistant>({
      type: "assistant",
      id: "msg_assistant_0",
      time: { created: time, completed: time },
      tokens: { ...tokens, input: 11 },
      cost: 0,
    });
    const changed = await collect();
    const unchanged = await collect();
    const [entry] = storage.sql
      .exec<{ input: number }>("SELECT input FROM usage_entry WHERE id = 'msg_assistant_0'")
      .toArray();
    return { initial, idle, changed, unchanged, input: entry!.input };
  } finally {
    storage.sql.exec = exec;
  }
}
