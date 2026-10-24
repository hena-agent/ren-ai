import { rm } from "node:fs/promises";
import { TestLLM } from "@opencode/ai/testing";
import { Effect, Schema } from "effect";
import { expect, test, vi } from "vitest";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";
import { readAdjustments, writeAdjustments } from "@ren-ai/plugin-session-folder/adjustments";
import { emptyAdjustments } from "../../../../packages/plugins/session-folder/src/adjustment-model.ts";
import { folderFiles, renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { exportSessions, restoreSessions } from "./transfer.ts";
import { sessionArchive } from "./transfer-format.ts";

test("real OC occasionally reviews adjustments and uses the new document on its next model step and other Conversations", () =>
  withRemoteHost((remote, directory, { llm }) =>
    Effect.gen(function* () {
      const first = yield* remote.createSession("persona1");
      const files = folderFiles(directory);
      const initial = yield* Effect.promise(() => files.read(first.id));
      yield* Effect.promise(() =>
        writeAdjustments(first.location.directory, {
          ...emptyAdjustments(),
          state: { ...emptyAdjustments().state, reviewedAt: Date.now() - 86_400_001, observed: 19 },
        }),
      );
      let reviewed = false;
      yield* llm.serve((request) => {
        if (!request.tools.some((tool) => tool.name === "review_adjustments"))
          return TestLLM.text("Persona1", "title");
        const system = JSON.stringify(request.system);
        if (!reviewed && !system.includes("<adjustment-review"))
          return TestLLM.text("잠깐 확인했어.", "idle");
        if (!reviewed) {
          reviewed = true;
          const reviewID = /reviewID=\\"([^\\]+)\\"/.exec(system)![1]!;
          return TestLLM.tool("adjust-methods", "review_adjustments", {
            reviewID,
            markdown: "관심이 가는 화제에는 내 생각도 조금 보탠다.",
            reason: "짧은 반응으로 화제를 너무 빨리 닫는 경향을 보정한다.",
          });
        }
        expect(system).toContain("관심이 가는 화제에는 내 생각도 조금 보탠다.");
        expect(system).not.toContain("<adjustment-review");
        return TestLLM.text("나도 그 얘기 좋아해.", "answer");
      });
      yield* remote.sessions.prompt({
        sessionID: first.id,
        text: "<checked-phone>quiet</checked-phone>",
      });
      yield* remote.sessions.wait(first.id);
      expect(reviewed).toBe(false);
      yield* remote.sessions.prompt({ sessionID: first.id, text: "요즘 읽은 책 이야기할까?" });
      yield* remote.sessions.wait(first.id);
      expect((yield* remote.sessions.get(first.id)).outcome).toBe("succeeded");
      expect(reviewed).toBe(true);
      const current = yield* Effect.promise(() => files.read(first.id));
      expect(current.rules).toBe(initial.rules);
      expect(current.agent).toBe(initial.agent);
      expect(current.adjustments!.state.history).toHaveLength(1);
      const sandbox = yield* Effect.promise(() =>
        files.write("ses_adjustment_copy", current, {
          sandbox: true,
        }),
      );
      expect(yield* Effect.promise(() => readAdjustments(sandbox))).toEqual(current.adjustments);
      yield* Effect.promise(() => writeAdjustments(sandbox, emptyAdjustments()));
      expect(yield* Effect.promise(() => readAdjustments(first.location.directory))).toEqual(
        current.adjustments,
      );
      const second = yield* remote.createSession("persona1");
      yield* remote.sessions.prompt({ sessionID: second.id, text: "안녕" });
      yield* remote.sessions.wait(second.id);
      expect((yield* remote.sessions.get(second.id)).outcome).toBe("succeeded");
      expect(
        (yield* Effect.promise(() => readAdjustments(first.location.directory)))!.state.history,
      ).toHaveLength(1);

      const before = yield* Effect.promise(() => readAdjustments(first.location.directory));
      // Catalog updates preserve learned adjustments instead of resetting them from a snapshot.
      yield* remote.client.rpc(sessionFolders).update(
        {
          folderID: first.id,
          snapshot: renderSnapshot(
            { ...initial.persona, prompt: "You are Persona1. Updated identity." },
            initial.rules,
          ),
        },
        { location: { directory } },
      );
      expect((yield* Effect.promise(() => files.read(first.id))).adjustments).toEqual(before);
      const archive = yield* exportSessions(remote.client, [first.id, second.id]);
      const decoded = Schema.decodeUnknownSync(sessionArchive)(archive);
      expect(decoded.personas[0]!.snapshot.adjustments).toEqual(before);
      yield* remote.sessions.remove(first.id);
      yield* remote.sessions.remove(second.id);
      yield* Effect.promise(() => rm(first.location.directory, { recursive: true }));
      yield* restoreSessions(remote.client, archive, directory);
      expect(yield* Effect.promise(() => readAdjustments(first.location.directory))).toEqual(
        before,
      );
    }),
  ));

test("native adjustment failures retain correlation and diagnostics without logging private model inputs", () =>
  withRemoteHost((remote, _directory, { llm }) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      const logs: string[] = [];
      const sinks = (["log", "error", "warn"] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation((...items) => {
          logs.push(items.map((item) => JSON.stringify(item)).join(" "));
        }),
      );
      let step = 0;
      try {
        yield* llm.serve((request) => {
          if (!request.tools.some((tool) => tool.name === "review_adjustments"))
            return TestLLM.text("Persona1", "title");
          return step++ === 0
            ? TestLLM.tool("unauthorized-review", "review_adjustments", {
                reviewID: "private-review-token",
                markdown: "private-adjustment-token",
                reason: "private-reason-token",
              })
            : TestLLM.text("이야기하자.", "answer");
        });
        yield* remote.sessions.prompt({ sessionID: session.id, text: "private-user-text" });
        yield* remote.sessions.wait(session.id);
        const diagnostic = logs.find((line) => line.includes('"operation":"review_adjustments"'))!;
        expect(diagnostic).toContain("unauthorized-review");
        expect(diagnostic).toContain(session.id);
        expect(diagnostic).toContain('"stage":"review"');
        expect(diagnostic).toContain("ADJUSTMENT_REVIEW_CONFLICT");
        expect(diagnostic).toContain("durationMs");
        const requestID = /"requestID":"([^"]+)"/.exec(diagnostic)![1]!;
        expect(JSON.stringify((yield* llm.requests()).at(-1)!.messages)).toContain(requestID);
        expect(diagnostic).not.toContain("private-");
      } finally {
        for (const sink of sinks) sink.mockRestore();
      }
    }),
  ));
