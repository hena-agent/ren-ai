import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { fakeMessages } from "../../imsg/src/messages/messages.fake.ts";
import { fakeGestures } from "../../imsg/src/gestures/gestures.fake.ts";
import type { ApplicationStore } from "../src/application-store.ts";
import { conversations } from "../src/conversations/conversations.ts";
import { outbox } from "../src/outbox/outbox.ts";
import { storageMeter } from "./storage-meter.test-helper.ts";

export async function outboxBudget(storage: DurableObjectStorage, store: ApplicationStore) {
  const conversation = await store.run(
    Effect.gen(function* () {
      return yield* (yield* conversations).create({
        handle: "budget@example.test",
        sessionID: "budget",
        personaID: "budget",
        locale: "en",
        consentVersion: "v1",
        consentLanguage: "en",
      });
    }),
  );
  const messages = fakeMessages();
  const meter = storageMeter(storage);
  const budgets = [];
  try {
    for (const size of [100, 10000]) {
      await store.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM history WHERE n < ${size})
          INSERT INTO send (handle, conversation_id, kind, content, state, recorded_at, updated_at)
          SELECT ${conversation.handle}, ${conversation.id}, 'text', 'past', 'sent', 0, 0 FROM history`;
        }),
      );
      meter.reset();
      // Recreate the outbox to exercise actor replacement, then repeat idle context checks.
      await store.run(
        Effect.gen(function* () {
          const sends = yield* outbox(messages.messages, fakeGestures().gestures, new Map());
          yield* sends.observe(conversation);
          yield* sends.observe(conversation);
        }),
      );
      const query = meter.queries.find((entry) => entry.includes("FROM send"))!;
      budgets.push({
        size,
        ...meter.totals(),
        plan: storage.sql.exec(`EXPLAIN QUERY PLAN ${query}`, conversation.id).toArray(),
      });
    }
    return budgets;
  } finally {
    meter.restore();
  }
}
