import { TestLLM } from "@opencode/ai/testing";
import { Effect, Schema, Stream } from "effect";
import { expect, test, vi } from "vitest";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";
import { personaMemory, readRuntime } from "@ren-ai/plugin-session-folder/memory";
import { restoreMemory, emptyMemory } from "../../test/memory.test-helper.ts";
import { exportSessions, restoreSessions } from "./transfer.ts";
import { providerUnavailable } from "../../test/messaging-host.test-helper.ts";

test("real OC tools share current life while keeping affection and Relationship memory private", () =>
  withRemoteHost((remote, _directory, { llm }) =>
    Effect.gen(function* () {
      const first = yield* remote.createSession("persona1");
      const actions = [
        {
          name: "update_state",
          input: {
            scope: "life",
            scores: {
              mood: 55,
              energy: 30,
              stress: 35,
              connection: 55,
              solitude: 60,
              affection: 27,
            },
            additions: {
              "작업 단계": {
                value: "사진 선정",
                meaning: "현재 작업",
                reason: "사진전을 준비한다.",
              },
            },
            remove: [],
            reason: "밤샘 작업",
          },
        },
        {
          name: "update_memory",
          input: {
            scope: "relationship",
            markdown: "# 현재 생활\n\n내일 사진전 소식을 이야기하기로 했다.",
            reason: "약속을 확인했다.",
          },
        },
        {
          name: "remember",
          input: {
            scope: "relationship",
            topic: "상대의 취향",
            text: "상대는 민트 차를 좋아한다.",
            summary: "민트 차를 좋아함",
            clarity: "clear",
            reason: "상대가 직접 말했다.",
          },
        },
        { name: "search_memory", input: { query: "민트" } },
      ];
      let step = 0;
      yield* llm.serve((request) => {
        expect(request.tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["dice", ...actions.map((action) => action.name)]),
        );

        const action = actions[step++];
        return action
          ? TestLLM.tool(`memory-${step}`, action.name, action.input)
          : TestLLM.text("기억했어요.", "answer");
      });
      yield* remote.sessions.prompt({
        sessionID: first.id,
        text: "사진전 약속과 민트 차 취향을 기억해.",
      });
      yield* remote.sessions.wait(first.id);
      expect((yield* remote.sessions.get(first.id)).outcome).toBe("succeeded");
      expect(step).toBe(5);
      const requests = yield* llm.requests();
      const current = JSON.stringify(requests.at(-1)!.system);
      expect(current).toContain("energy: 30");
      expect(current).toContain("affection: 27");
      expect(current).toContain("사진 선정");
      expect(current).toContain("내일 사진전 소식");
      expect(current).not.toContain("민트 차를 좋아한다");
      expect(JSON.stringify(requests.at(-1)!.messages)).toContain("민트 차를 좋아한다");
      expect(
        yield* Effect.promise(() => personaMemory(first.location.directory, first.id).context()),
      ).toContain("사진 선정");
      const second = yield* remote.createSession("persona1");
      yield* llm.serve(() => TestLLM.text("처음 만나요.", "answer"));
      yield* remote.sessions.prompt({ sessionID: second.id, text: "안녕하세요." });
      yield* remote.sessions.wait(second.id);
      const other = JSON.stringify((yield* llm.requests()).at(-1)!);
      expect(other).toContain("사진 선정");
      expect(other).toContain("energy: 30");
      expect(other).not.toContain("affection: 27");
      expect(other).not.toContain("내일 사진전 소식");
      expect(other).not.toContain("민트 차");
      expect(
        yield* Effect.promise(() =>
          personaMemory(second.location.directory, second.id).run(
            "search_memory",
            { query: "민트" },
            "search",
            "other",
          ),
        ),
      ).toBe("[]");
    }),
  ));

test("dice and memory receipts survive failed work and an exported/restored native OC session", () =>
  withRemoteHost((remote, directory, { llm }) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
      const input = {
        scope: "relationship",
        topic: "취향",
        text: "상대는 민트 차를 좋아한다.",
        summary: "민트 차",
        clarity: "clear",
        reason: "상대가 직접 알려 줬다.",
      };
      let step = 0;
      try {
        yield* llm.serve((request) => {
          if (!request.tools.some((tool) => tool.name === "dice"))
            return TestLLM.text("Persona1", "title");
          return ++step === 1
            ? TestLLM.tool("persistent-roll", "dice", {})
            : step === 2
              ? TestLLM.tool("persistent-memory", "remember", input)
              : providerUnavailable("offline");
        });
        yield* remote.sessions.prompt({ sessionID: session.id, text: "기억해 주세요." });
        yield* remote.sessions.wait(session.id);
        expect((yield* remote.sessions.get(session.id)).outcome).toBe("failed");
        expect(
          (yield* llm.requests())
            .flatMap((request) => request.messages.flatMap((message) => message.content))
            .filter((part) => part.type === "tool-result")
            .filter((part) => part.name === "dice")
            .map((part) => part.result),
        ).toContainEqual({ type: "text", value: "5000" });
        const before = yield* Effect.promise(() => readRuntime(session.location.directory));
        const diceID = Object.entries(before!.receipts).find(
          ([, receipt]) => receipt.operation === "dice",
        )![0];
        const archive = yield* exportSessions(remote.client, [session.id]);
        yield* remote.sessions.remove(session.id);
        yield* restoreSessions(remote.client, archive, directory);
        random.mockReturnValue(0.9);
        yield* llm.serve((request) => {
          if (!request.tools.some((tool) => tool.name === "dice"))
            return TestLLM.text("Persona1", "title");
          expect(JSON.stringify(request.messages)).toContain("5000");
          expect(JSON.stringify(request.messages)).toContain("민트 차");
          return TestLLM.text("이어 갈게요.", "answer");
        });
        yield* remote.retry(session.id);
        yield* remote.sessions.wait(session.id);
        expect((yield* remote.sessions.get(session.id)).outcome).toBe("succeeded");
        const memory = personaMemory(session.location.directory, session.id);
        const results = yield* Effect.promise(() =>
          memory.run("search_memory", { query: "민트" }, "search", "after-restore"),
        );
        expect(JSON.parse(results)).toHaveLength(1);
        const replayRandom = vi.fn<() => number>(() => 0.9);
        expect(
          yield* Effect.promise(() =>
            memory.roll(diceID.slice(session.id.length + 1), "after-restore", replayRandom),
          ),
        ).toBe("5000");
        expect(replayRandom).not.toHaveBeenCalled();
        const restored = yield* Effect.promise(() => readRuntime(session.location.directory));
        expect(
          Object.values(restored!.receipts).filter((receipt) => receipt.operation === "dice"),
        ).toHaveLength(1);
      } finally {
        random.mockRestore();
      }
    }),
  ));

test("real OC compaction receives current Memory and loss markers without resetting the files", () =>
  withRemoteHost((remote, _directory, { llm }) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      const memory = personaMemory(session.location.directory, session.id);
      const record = yield* Effect.promise(async () =>
        Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ id: Schema.String })))(
          await memory.run(
            "remember",
            {
              scope: "relationship",
              topic: "생일",
              text: "birthday-detail-0317",
              summary: "생일 날짜",
              clarity: "clear",
              reason: "상대가 직접 말했다.",
            },
            "learn-birthday",
            "first",
          ),
        ),
      );
      yield* Effect.promise(() =>
        memory.run(
          "update_memory",
          {
            scope: "relationship",
            markdown: "# 현재 생활\n\nbirthday-detail-0317",
            reason: "현재 기억",
          },
          "short-birthday",
          "first",
        ),
      );
      yield* llm.serve((request) =>
        request.tools.some((tool) => tool.name === "remember")
          ? TestLLM.textWithUsage("알겠어요.", "answer", 80_000)
          : TestLLM.text("Persona1", "title"),
      );
      yield* remote.sessions.prompt({ sessionID: session.id, text: "birthday-detail-0317" });
      yield* remote.sessions.wait(session.id);
      yield* Effect.promise(() => memory.roll("forget-roll", "later", () => 0.5));
      yield* Effect.promise(() =>
        memory.run(
          "remember",
          {
            scope: "relationship",
            id: record.id,
            topic: "생일",
            text: "",
            summary: "",
            clarity: "forgotten",
            reason: "오래 떠올리지 않았다.",
            diceCall: "forget-roll",
            shortTerm: "# 현재 생활\n\n사진전 작품을 고르는 중이다.",
          },
          "forget-birthday",
          "later",
        ),
      );
      let summaries = 0;
      let summaryPrompt = "";
      let summaryMessages = "";
      yield* llm.serve((request) => {
        if (JSON.stringify(request.messages).includes("Write her Memory")) {
          summaries++;
          const prompt = request.messages
            .flatMap((message) => message.content)
            .filter((part) => part.type === "text")
            .find((part) => part.text.includes("Write her Memory"))!.text;
          summaryPrompt = prompt;
          summaryMessages = JSON.stringify(request.messages);
          return TestLLM.text(
            "## Important Context\n상대에 대해: 생일 날짜가 기억나지 않는다.\n둘 사이: 아직 알아가는 중.\n약속: 없음.\n최근: 사진전 작품을 고른다.",
            "memory-summary",
          );
        }
        return TestLLM.text("작품 고르는 중이에요.", "answer");
      });
      yield* remote.sessions.prompt({ sessionID: session.id, text: "요즘 어떻게 지내요?" });
      yield* remote.sessions.wait(session.id);
      expect((yield* remote.sessions.get(session.id)).outcome).toBe("succeeded");
      expect(summaries).toBe(1);
      expect(summaryPrompt).toContain("사진전 작품을 고르는 중");
      expect(summaryPrompt).toContain("forgotten");
      expect(summaryPrompt).not.toContain("birthday-detail-0317");
      expect(summaryMessages).toContain("omit forgotten details");
      expect(yield* Effect.promise(() => memory.context())).toContain("사진전 작품");
      expect(
        yield* Effect.promise(() =>
          memory.run("search_memory", { query: "생일" }, "after-compaction", "later"),
        ),
      ).toBe("[]");
    }),
  ));

test("real OC rejects a concurrent stale shared write with correlated JSON stderr diagnostics and current model data", () =>
  withRemoteHost((remote, _directory, { llm }) =>
    Effect.gen(function* () {
      const first = yield* remote.createSession("persona1");
      const second = yield* remote.createSession("persona1");
      yield* Effect.promise(() =>
        restoreMemory(first.location.directory, {
          ...emptyMemory,
          state: { mood: 50, energy: 60, stress: 20, connection: 40, solitude: 30, traits: {} },
        }),
      );
      const logs: string[] = [];
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        logs.push(String(chunk));
        return true;
      });
      let firstStep = true;
      try {
        yield* llm.serve((request) => {
          if (!request.tools.some((tool) => tool.name === "update_state"))
            return TestLLM.text("Persona1", "title");
          if (!firstStep) return TestLLM.text("I will use my current energy.", "done");
          firstStep = false;
          expect(JSON.stringify(request.system)).toContain("energy: 60");
          return Stream.fromEffect(
            Effect.promise(async () => {
              const other = personaMemory(second.location.directory, second.id);
              await other.context();
              await other.run(
                "update_state",
                {
                  scores: { energy: 20 },
                  additions: {},
                  remove: [],
                  reason: "private-safe-evidence-token",
                },
                "other-change",
                "private-source-token",
              );
            }).pipe(Effect.orDie),
          ).pipe(
            Stream.flatMap(() =>
              Stream.fromIterable(
                TestLLM.tool("stale-model-write", "update_state", {
                  scores: { energy: 90 },
                  additions: {},
                  remove: [],
                  reason: "private-model-prompt-token",
                }),
              ),
            ),
          );
        });
        yield* remote.sessions.prompt({ sessionID: first.id, text: "Check your energy." });
        yield* remote.sessions.wait(first.id);
        const latest = (yield* llm.requests()).at(-1)!;
        expect(JSON.stringify(latest.system)).toContain("energy: 20");
        expect(JSON.stringify(latest.messages)).toContain("SHARED_MEMORY_CONFLICT");
        const warning = Schema.decodeUnknownSync(
          Schema.fromJsonString(
            Schema.Struct({
              level: Schema.Literal("warn"),
              stage: Schema.Literal("compare-and-swap"),
              code: Schema.Literal("SHARED_MEMORY_CONFLICT"),
              requestID: Schema.String,
              sessionID: Schema.String,
              callID: Schema.String,
              durationMs: Schema.Number,
            }),
          ),
        )(logs.find((line) => line.includes("SHARED_MEMORY_CONFLICT")));
        expect(warning.sessionID).toBe(first.id);
        expect(warning.callID).toBe("stale-model-write");
        expect(JSON.stringify(latest.messages)).toContain(warning.requestID);
        expect(logs.join("")).not.toContain("private-");
      } finally {
        stderr.mockRestore();
      }
    }),
  ));
