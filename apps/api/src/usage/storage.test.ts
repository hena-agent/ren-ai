import { fromPartial } from "@total-typescript/shoehorn";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import type { MessageListOutput } from "@opencode/client/effect/api";
import { DateTime, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test, vi } from "vitest";
import { registration, runMessagingTest } from "../../test/messaging.test-helper.ts";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { usageCollector } from "./collect.ts";

const time = DateTime.makeUnsafe(1000);
const sessionInfo = (id: string, updated = 1000) =>
  fromPartial<Session.Info>({
    id,
    time: { created: time, updated: DateTime.makeUnsafe(updated) },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
  });

test("unchanged usage survives collector replacement without history reads or snapshot writes; new turns leave old rows untouched", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const directory = yield* conversations;
      yield* directory.create(registration("usage@example.test", "ses_storage"));
      let revision = 1;
      let history = [
        fromPartial<SessionMessage.User>({
          id: "msg_first",
          type: "user",
          time: { created: time },
        }),
        fromPartial<SessionMessage.Idle>({
          id: "msg_idle",
          type: "idle",
          outcome: "succeeded",
          time: { created: time },
        }),
      ];
      const messages = vi.fn<() => Effect.Effect<MessageListOutput>>(() =>
        Effect.succeed({ data: history, cursor: {} }),
      );
      const api = {
        messages,
        get: () => Effect.succeed(sessionInfo("ses_storage", revision)),
      };
      const collector = yield* usageCollector(api);
      yield* collector.tick;
      yield* sql`CREATE TRIGGER protect_closed_turn BEFORE UPDATE ON usage_turn
        WHEN OLD.id = 'msg_first' BEGIN SELECT RAISE(ABORT, 'historical turn rewritten'); END`;
      const restarted = yield* usageCollector(api);
      yield* restarted.session("ses_storage");
      expect(messages).toHaveBeenCalledTimes(1);
      history = [
        ...history,
        fromPartial<SessionMessage.User>({
          id: "msg_second",
          type: "user",
          time: { created: time },
        }),
        fromPartial<SessionMessage.Idle>({
          id: "msg_second_idle",
          type: "idle",
          outcome: "succeeded",
          time: { created: time },
        }),
      ];
      revision++;
      yield* restarted.session("ses_storage");
      expect(messages).toHaveBeenCalledTimes(2);
      expect(yield* sql`SELECT id FROM usage_turn ORDER BY rowid`).toEqual([
        { id: "msg_first" },
        { id: "msg_second" },
      ]);
      yield* sql`UPDATE usage_session SET unavailable = 1`;
      yield* restarted.session("ses_storage");
      expect(messages).toHaveBeenCalledTimes(3);
      expect(yield* sql`SELECT unavailable FROM usage_session`).toEqual([{ unavailable: 0 }]);
    }),
  ));

test("idle reconciliation uses an index rather than scanning all usage entries", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN UPDATE usage_entry
      SET outcome = 'unmeasured', ended_at = 1 WHERE turn_id = 'turn' AND outcome = 'running'`;
      expect(plan.some((row) => row.detail.includes("SEARCH usage_entry USING INDEX"))).toBe(true);
      expect(plan.some((row) => row.detail.includes("SCAN usage_entry"))).toBe(false);
    }),
  ));

test("maintenance bounds usage checks, spaces unchanged checks and excludes replaced or finalized sessions", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const directory = yield* conversations;
      for (let index = 0; index < 25; index++)
        yield* directory.create(registration(`batch-${index}@example.test`, `ses_batch_${index}`));
      const get = vi.fn<(id: Session.ID) => Effect.Effect<Session.Info>>((id) =>
        Effect.succeed(sessionInfo(id)),
      );
      const messages = vi.fn<() => Effect.Effect<MessageListOutput>>(() =>
        Effect.succeed({ data: [], cursor: {} }),
      );
      const collector = yield* usageCollector({ get, messages });
      yield* collector.tick;
      expect(get).toHaveBeenCalledTimes(20);
      yield* collector.tick;
      expect(get).toHaveBeenCalledTimes(25);
      yield* collector.tick;
      expect(get).toHaveBeenCalledTimes(25);
      const first = (yield* directory.bySession("ses_batch_0"))!;
      yield* directory.replaceSession(first, "ses_replaced");
      yield* collector.session(first.sessionID);
      yield* sql`UPDATE usage_session SET next_check_at = 0`;
      get.mockClear();
      yield* collector.tick;
      expect(get.mock.calls.some(([id]) => id === "ses_batch_0")).toBe(false);
    }),
  ));

test("missing native checkpoints preserve saved usage and report a failure instead of replaying closed history", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const directory = yield* conversations;
      yield* directory.create(registration("checkpoint@example.test", "ses_missing"));
      yield* sql`UPDATE usage_session SET last_idle = 'missing'`;
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const collector = yield* usageCollector({
          messages: () => Effect.succeed({ data: [], cursor: {} }),
          get: () => Effect.succeed(sessionInfo("ses_missing")),
        });
        yield* collector.tick;
        expect(yield* sql`SELECT unavailable, last_idle, fingerprint FROM usage_session`).toEqual([
          { unavailable: 1, last_idle: "missing", fingerprint: null },
        ]);
        expect(stderr).toHaveBeenCalled();
      } finally {
        stderr.mockRestore();
      }
    }),
  ));

test("stopped sessions receive their final snapshot once, while already finalized snapshots retire without history access", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const directory = yield* conversations;
      for (const [id, syncedAt] of [
        ["ses_new", null],
        ["ses_stale", 0],
        ["ses_fresh", 2],
      ] as const) {
        const conversation = yield* directory.create(registration(`${id}@example.test`, id));
        yield* sql`UPDATE conversation SET ended_at = 1 WHERE id = ${conversation.id}`;
        yield* sql`INSERT INTO conversation_end (conversation_id, call_id, farewell, notice, token_hash, stopped_at)
        VALUES (${conversation.id}, ${id}, '', '', ${id}, 1)`;
        yield* sql`UPDATE usage_session SET synced_at = ${syncedAt} WHERE session_id = ${id}`;
      }
      const get = vi.fn<(id: Session.ID) => Effect.Effect<Session.Info>>((id) =>
        Effect.succeed(sessionInfo(id)),
      );
      const collector = yield* usageCollector({
        get,
        messages: () => Effect.succeed({ data: [], cursor: {} }),
      });
      yield* collector.tick;
      expect(get).toHaveBeenCalledTimes(2);
      expect(get.mock.calls.map(([id]) => id)).toEqual(["ses_new", "ses_stale"]);
      yield* collector.tick;
      expect(get).toHaveBeenCalledTimes(2);
      expect(yield* sql`SELECT next_check_at FROM usage_session`).toEqual(
        Array.from({ length: 3 }, () => ({ next_check_at: null })),
      );
    }),
  ));
