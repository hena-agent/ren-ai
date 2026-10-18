import { fromPartial } from "@total-typescript/shoehorn";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { Model } from "@opencode/schema/model";
import type { MessageListInput, MessageListOutput } from "@opencode/client/effect/api";
import { DateTime, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test, vi } from "vitest";
import { runMessagingTest, registration } from "../../test/messaging.test-helper.ts";
import { migrate } from "../database.ts";
import { conversations } from "../conversations/conversations.ts";
import { conversationStatus } from "../conversations/status.ts";
import { conversationRecords } from "../conversations/http.ts";
import { exportApplicationState, importApplicationState } from "../state-snapshot.ts";
import { usageCollector } from "./collect.ts";
import { usageQueries } from "./query.ts";

const time = DateTime.makeUnsafe(1000);
const tokens = { input: 100, output: 20, reasoning: 30, cache: { read: 40, write: 50 } };
const session = fromPartial<Session.Info>({
  id: "ses_usage",
  time: { created: time },
  tokens,
  cost: 1,
});
const user = (id: string) =>
  fromPartial<SessionMessage.User>({
    type: "user",
    id,
    text: "PRIVATE USER TEXT",
    time: { created: time },
  });
const assistant = (id: string, extra: Partial<SessionMessage.Assistant> = {}) =>
  fromPartial<SessionMessage.Assistant>({
    type: "assistant",
    id,
    model: { ...Model.Ref.parse("test/model"), variant: Model.VariantID.make("fast") },
    tokens,
    cost: session.cost,
    finish: "tool-calls",
    time: { created: time, completed: time },
    ...extra,
  });
const idle = (id: string, outcome: SessionMessage.Idle["outcome"] = "succeeded") =>
  fromPartial<SessionMessage.Idle>({ type: "idle", id, outcome, time: { created: time } });

test("all steps in an idle-delimited turn, including steered input, are durable and idempotent across replacement and state restore", async () => {
  const snapshot = await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const directory = yield* conversations;
      const conversation = yield* directory.create(
        registration("private@example.test", session.id),
      );
      const pages = [
        user("msg_user"),
        assistant("msg_first"),
        user("msg_steered"),
        assistant("msg_second"),
        idle("msg_idle"),
      ];
      const messages = vi.fn<(input: MessageListInput) => Effect.Effect<MessageListOutput>>(
        (input) =>
          Effect.succeed(
            input.cursor
              ? { data: pages.slice(2), cursor: {} }
              : { data: pages.slice(0, 2), cursor: { next: "opaque-cursor" } },
          ),
      );
      const collector = yield* usageCollector({ messages, get: () => Effect.succeed(session) });
      yield* collector.session("not-bound");
      expect(messages).not.toHaveBeenCalled();
      yield* collector.tick;
      const query = yield* usageQueries;
      const first = (yield* query(conversation.id))!;
      expect(first.turns).toHaveLength(1);
      expect(first.turns[0]!.entries).toHaveLength(2);
      expect(first.turns[0]!.totals).toMatchObject({
        input: 200,
        output: 40,
        reasoning: 60,
        cacheRead: 80,
        cacheWrite: 100,
        estimatedCostUSD: 2,
      });
      expect(messages).toHaveBeenCalledWith({ sessionID: session.id, cursor: "opaque-cursor" });
      expect(JSON.stringify(first)).not.toMatch(/PRIVATE|private@example/);
      yield* collector.tick;
      expect((yield* query(conversation.id))!.totals).toEqual(first.totals);
      expect(yield* query(999)).toBeUndefined();
      yield* directory.replaceSession(conversation, "ses_replacement");
      expect((yield* query(conversation.id))!.sessions).toHaveLength(2);
      const archive = yield* exportApplicationState;
      yield* sql`DELETE FROM user`;
      expect((yield* sql`SELECT * FROM usage_entry`).length).toBe(3);
      const reset = yield* directory.create(registration("reset@example.test", "ses_after_reset"));
      expect((yield* query(reset.id))!.totals).toEqual([]);
      return archive;
    }),
  );
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      yield* importApplicationState(snapshot);
      const query = yield* usageQueries;
      expect((yield* query(1))!.turns[0]!.entries).toHaveLength(2);
    }),
  );
});

test("running, interrupted and failed steps preserve missing usage and safe diagnostic fields; queries paginate whole turns", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const directory = yield* conversations;
      const conversation = yield* directory.create(registration("test@example.test", session.id));
      const query = yield* usageQueries;
      expect((yield* query(conversation.id))!.turns).toEqual([]);
      const {
        tokens: _tokens,
        cost: _cost,
        finish: _finish,
        ...unmeasured
      } = assistant("msg_unknown", { time: { created: time } });
      const compaction = fromPartial<SessionMessage.CompactionRunning>({
        type: "compaction",
        status: "running",
        id: "msg_compact",
        time: { created: time },
      });
      let history: readonly SessionMessage.Info[] = [
        fromPartial<SessionMessage.Info>({
          type: "system",
          id: "msg_system",
          time: { created: time },
        }),
        user("msg_first"),
        unmeasured,
        compaction,
      ];
      const collector = yield* usageCollector({
        messages: () => Effect.succeed({ data: history, cursor: {} }),
        get: () =>
          Effect.succeed(
            fromPartial<Session.Info>({
              id: session.id,
              tokens,
              cost: session.cost,
              time: { created: time, updated: DateTime.makeUnsafe(history.length) },
            }),
          ),
      });
      yield* collector.session(session.id);
      expect((yield* query(conversation.id))!.turns[0]!.totals.unmeasuredEntries).toBe(2);
      history = [
        user("msg_first"),
        unmeasured,
        fromPartial<SessionMessage.CompactionFailed>({
          type: "compaction",
          id: compaction.id,
          time: compaction.time,
          status: "failed",
          error: { type: "compaction.failed", message: "PRIVATE SUMMARY" },
          tokens,
        }),
        idle("msg_end", "interrupted"),
        fromPartial<SessionMessage.Info>({
          type: "synthetic",
          id: "msg_recover",
          text: "PRIVATE",
          time: { created: time },
        }),
        assistant("msg_failed", {
          error: { type: "upstream", message: "PRIVATE ERROR", status: 502 },
        }),
        idle("msg_failed_end", "failed"),
        assistant("msg_nostatus", { error: { type: "error", message: "PRIVATE" } }),
        idle("msg_end_nostatus", "failed"),
        fromPartial<SessionMessage.CompactionCompleted>({
          type: "compaction",
          status: "completed",
          id: "msg_old_summary",
          time: { created: time },
        }),
        idle("msg_old_end"),
      ];
      yield* collector.session(session.id);
      const detail = (yield* query(conversation.id))!;
      expect(detail.turns).toHaveLength(4);
      expect(detail.turns.flatMap((turn) => turn.entries)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "msg_unknown", input: null, outcome: "unmeasured" }),
          expect.objectContaining({ id: "msg_failed", upstreamStatus: 502, errorType: "upstream" }),
        ]),
      );
      expect(JSON.stringify(detail)).not.toContain("PRIVATE");
      history = [
        ...history,
        ...Array.from({ length: 51 }, (_, index) => [
          user(`msg_page_${index}`),
          idle(`msg_idle_${index}`),
        ]).flat(),
      ];
      yield* collector.session(session.id);
      const page = (yield* query(conversation.id))!;
      expect(page.turns).toHaveLength(50);
      expect((yield* query(conversation.id, page.nextBefore!))!.turns).toHaveLength(5);
      const status = yield* conversationStatus(async () => []);
      const handler = conversationRecords(status, Effect.runPromise, query);
      for (const [path, code] of [
        [`${conversation.id}/usage`, 200],
        [`${conversation.id}/usage?before=1`, 200],
        [`${conversation.id}/usage?before=-1`, 400],
        ["999/usage", 404],
      ]) {
        const response = yield* Effect.promise(() =>
          handler(new Request(`https://api.test/management/conversations/${path}`)),
        );
        expect(response.status).toBe(code);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    }),
  ));

test("pagination and upstream failures preserve the previous snapshot and emit correlated redacted diagnostics", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const directory = yield* conversations;
      yield* directory.create(registration("private@example.test", session.id));
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const collector = yield* usageCollector({
          messages: () => Effect.fail(new Error("PRIVATE PROMPT token-secret")),
          get: () => Effect.succeed(session),
        });
        yield* collector.tick;
        expect(yield* sql`SELECT unavailable, synced_at FROM usage_session`).toEqual([
          { unavailable: 1, synced_at: null },
        ]);
        const diagnostics = stderr.mock.calls.map((call) => String(call[0])).join("");
        expect(diagnostics).toContain('"stage":"session.messages"');
        expect(diagnostics).toContain('"requestId":');
        expect(diagnostics).not.toMatch(/PRIVATE|token-secret|private@example/);
        const cyclic = yield* usageCollector({
          messages: () => Effect.succeed({ data: [], cursor: { next: "same" } }),
          get: () => Effect.succeed(session),
        });
        yield* cyclic.session(session.id).pipe(Effect.result);
        expect(yield* sql`SELECT COUNT(*) AS count FROM usage_entry`).toEqual([{ count: 0 }]);
        const healthy = yield* usageCollector({
          messages: () => Effect.succeed({ data: [], cursor: {} }),
          get: () => Effect.succeed(session),
        });
        yield* healthy.session(session.id);
        expect(yield* sql`SELECT unavailable FROM usage_session`).toEqual([{ unavailable: 0 }]);
      } finally {
        stderr.mockRestore();
      }
    }),
  ));
