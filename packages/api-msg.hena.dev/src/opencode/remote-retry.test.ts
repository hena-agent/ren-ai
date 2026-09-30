import { Effect } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { expect, test } from "vitest";
import {
  withRemoteHost,
  requestText,
  exportedSession,
  replaceCheckpoint,
} from "../../test/remote-host.test-helper.ts";
import { providerUnavailable } from "../../test/messaging-host.test-helper.ts";

test("each failed assistant gets its own durable retry and the model sees the no-repeat instruction", () =>
  withRemoteHost((remote, _directory, { llm }) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      for (const attempt of ["first", "second"]) {
        yield* llm.serve(() => providerUnavailable("offline"));
        yield* remote.sessions.prompt({ sessionID: session.id, text: `${attempt} failed request` });
        yield* remote.sessions.wait(session.id);
        yield* llm.serve((request) => {
          const text = requestText(request.messages);
          return TestLLM.text(
            text.includes("recorded tool results") &&
              text.includes("do not repeat completed sends or reactions")
              ? `${attempt} safe recovery`
              : "missing recovery instructions",
            "answer",
          );
        });
        yield* remote.retry(session.id);
        yield* remote.sessions.wait(session.id);
        expect((yield* remote.sessions.get(session.id)).outcome).toBe("succeeded");
        expect(
          JSON.stringify(yield* remote.sessions.messages({ sessionID: session.id })),
        ).toContain(`${attempt} safe recovery`);
      }
      const retries = yield* remote.sessions.messages({ sessionID: session.id, type: "synthetic" });
      expect(new Set(retries.map((message) => message.id)).size).toBe(2);
    }),
  ));

test("pending-work recovery presents its safety instruction to the resumed model", () =>
  withRemoteHost((remote, _directory, { llm }) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      yield* remote.sessions.prompt({
        sessionID: session.id,
        text: "queued request",
        resume: false,
      });
      yield* llm.serve((request) => {
        const text = requestText(request.messages);
        return TestLLM.text(
          text.includes("without repeating completed sends or reactions")
            ? "pending safely resumed"
            : "unsafe continuation",
          "answer",
        );
      });
      yield* remote.retry(session.id);
      yield* remote.sessions.wait(session.id);
      expect(JSON.stringify(yield* remote.sessions.messages({ sessionID: session.id }))).toContain(
        "pending safely resumed",
      );
    }),
  ));

test("an authoritative succeeded outcome suppresses retry even with an older failed assistant checkpoint", () =>
  withRemoteHost((remote, _directory, { llm }) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      yield* llm.serve(() => providerUnavailable("prior error"));
      yield* remote.sessions.prompt({ sessionID: session.id, text: "prior failure" });
      yield* remote.sessions.wait(session.id);
      const saved = yield* exportedSession(remote, session.id);
      yield* replaceCheckpoint(remote, {
        info: { ...saved.info, outcome: "succeeded" },
        messages: saved.messages,
      });
      expect((yield* remote.sessions.get(session.id)).outcome).toBe("succeeded");
      const [last] = yield* remote.sessions.messages({
        sessionID: session.id,
        type: "assistant",
        limit: 1,
      });
      expect(last?.type === "assistant" && last.error).toBeTruthy();
      const before = yield* llm.requests();
      yield* remote.retry(session.id);
      yield* remote.sessions.wait(session.id);
      expect(yield* llm.requests()).toEqual(before);
      expect(yield* remote.sessions.inbox(session.id)).toEqual([]);
    }),
  ));
