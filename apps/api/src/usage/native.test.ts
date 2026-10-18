import { TestLLM } from "@opencode/ai/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";
import { runMessagingTest, registration } from "../../test/messaging.test-helper.ts";
import { migrate } from "../database.ts";
import { conversations } from "../conversations/conversations.ts";
import { usageCollector } from "./collect.ts";
import { usageQueries } from "./query.ts";

test("real OpenCode message API meters Persona Memory and replays idle-delimited turns after collector restart", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.promise(() =>
        withRemoteHost((remote, _directory, { llm }) =>
          Effect.gen(function* () {
            const directory = yield* conversations;
            const session = yield* remote.createSession("persona1");
            const conversation = yield* directory.create(
              registration("meter@example.test", session.id),
            );
            yield* llm.serve((request) =>
              JSON.stringify(request.messages).includes("Write her Memory")
                ? TestLLM.textWithUsage(
                    "## Important Context\n상대에 대해: 차를 좋아한다.\n둘 사이: 알아가는 중.\n약속: 없음.\n최근: 산책.",
                    "summary",
                    1234,
                  )
                : TestLLM.textWithUsage("반가워요.", "answer", 80_000),
            );
            for (const text of ["안녕하세요.", "요즘 어떻게 지내요?"]) {
              yield* remote.sessions.prompt({ sessionID: session.id, text });
              yield* remote.sessions.wait(session.id);
            }
            const api = {
              messages: (input: Parameters<typeof remote.client.message.list>[0]) =>
                remote.client.message
                  .list(input)
                  .pipe(Effect.mapError((cause) => new Error("native history failed", { cause }))),
              get: remote.sessions.get,
            };
            const collector = yield* usageCollector(api);
            yield* collector.tick;
            const query = yield* usageQueries;
            const first = (yield* query(conversation.id))!;
            expect(first.sessions[0]!.unavailable).toBe(0);
            expect(first.turns).toHaveLength(2);
            const entries = first.turns.flatMap((turn) => turn.entries);
            expect(entries.filter((entry) => entry.source === "compaction")).toEqual([
              expect.objectContaining({ input: 1234, outcome: "succeeded", modelID: "probe" }),
            ]);
            const native = yield* remote.sessions.get(session.id);
            const all = [...entries, ...first.unattributed];
            expect(all.reduce((sum, entry) => sum + (entry.input ?? 0), 0)).toBe(
              native.tokens.input,
            );
            expect(all.reduce((sum, entry) => sum + (entry.output ?? 0), 0)).toBe(
              native.tokens.output,
            );
            expect(all.reduce((sum, entry) => sum + (entry.reasoning ?? 0), 0)).toBe(
              native.tokens.reasoning,
            );
            expect(first.unattributed[0]).toMatchObject({
              source: "session-overhead",
              input: 80_000,
              turnID: null,
              modelID: null,
            });
            const restarted = yield* usageCollector(api);
            yield* restarted.tick;
            expect((yield* query(conversation.id))!.totals).toEqual(first.totals);
            yield* remote.sessions.prompt({ sessionID: session.id, text: "다음 이야기" });
            yield* remote.sessions.wait(session.id);
            yield* restarted.tick;
            expect((yield* query(conversation.id))!.turns).toHaveLength(3);
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        ),
      );
    }),
  ));
