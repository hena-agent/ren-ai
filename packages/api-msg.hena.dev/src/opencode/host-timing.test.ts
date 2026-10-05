import { SqliteClient } from "@effect/sql-sqlite-node";
import { TestLLM } from "@opencode/ai/testing";
import { Effect, Fiber } from "effect";
import { expect, test } from "vitest";
import { fakeGestures } from "../gestures/gestures.fake.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { checkedPhone } from "../transcript/transcript.ts";
import {
  bindConversation,
  personaFixture,
  startScriptedMessagingHost,
} from "../../test/host.test-helper.ts";

test("a text admitted during wait wakes the real OpenCode tool for only its Conversation", async () => {
  const { root, personaDirectory, cleanup } = await personaFixture(
    "host-timing-",
    "---\ntime-zone: Pacific/Honolulu\nlanguage: ko\nopening-line: 안녕\nmemory: Remember.\n---\nYou are Persona1.\n",
  );
  const fake = fakeMessages();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()));
          let step = 0;
          yield* llm.serve((request) => {
            if (!request.tools.some((tool) => tool.name === "wait"))
              return TestLLM.text("title", "title");
            return step++ === 0
              ? TestLLM.tool("wait-call", "wait", { seconds: 600 })
              : TestLLM.text("done", "answer");
          });
          const host = yield* startScriptedMessagingHost(
            root,
            personaDirectory,
            llm,
            fake.messages,
            fakeGestures().gestures,
          );
          const session = yield* host.createSession("persona1");
          const conversation = yield* bindConversation(host, "wait@example.com", session.id);
          const request = yield* Effect.forkScoped(
            Effect.gen(function* () {
              while (
                !JSON.stringify(yield* host.sessions.messages({ sessionID: session.id })).includes(
                  '"status":"running"',
                )
              ) {
                yield* Effect.sleep("20 millis");
              }
              yield* Effect.sleep("50 millis");
              yield* fake.text("wait@example.com", "second", 2000);
            }),
          );
          yield* fake.text("wait@example.com", "first", 1000);
          yield* host.sessions.wait(session.id).pipe(Effect.timeout("3 seconds"));
          yield* Fiber.join(request);
          const turns = JSON.stringify(yield* host.sessions.messages({ sessionID: session.id }));
          expect(turns).toContain("cut short by something new");
          expect(turns).toContain("second");
          expect(turns).toMatch(new RegExp(`msg_checked_${conversation.id}_\\d+`));
          expect(
            [Date.now(), Date.now() - 60_000].some((at) =>
              turns.includes(JSON.stringify(checkedPhone(at, "Pacific/Honolulu")).slice(1, -1)),
            ),
          ).toBe(true);
          const firstRequest = (yield* llm.requests())[0]!;
          expect(JSON.stringify(firstRequest.tools)).toContain('"seconds"');
          expect(JSON.stringify(firstRequest.tools)).toContain(
            "Pause for the requested seconds (up to 3300 seconds / 55 minutes), or until something new arrives",
          );

          step = 0;
          const orphan = yield* host.createSession("persona1");
          yield* host.sessions.prompt({ sessionID: orphan.id, text: "pause" });
          yield* host.sessions.wait(orphan.id).pipe(Effect.timeout("3 seconds"));
          const errors = JSON.stringify(yield* host.sessions.messages({ sessionID: orphan.id }));
          expect(errors.match(/No Conversation for session/g)).toHaveLength(1);
        }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
      ),
    );
  } finally {
    await cleanup();
  }
}, 20000);

test.each([
  ["tapback", "wait"],
  ["tapback", "send"],
  ["edit", "wait"],
  ["edit", "send"],
  ["unsend", "wait"],
  ["unsend", "send"],
] as const)(
  "a %s ends active %s early through the real host",
  async (change, tool) => {
    const { root, personaDirectory, cleanup } = await personaFixture(
      "host-interruption-",
      "---\ntime-zone: Asia/Seoul\nlanguage: ko\nopening-line: 안녕\nmemory: Remember.\n---\nYou are Persona1.\n",
    );
    const fake = fakeMessages();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const llm = yield* Effect.provide(TestLLM.Test, TestLLM.testLayer());
            let step = 1;
            yield* llm.serve((request) => {
              if (!request.tools.some((entry) => entry.name === "wait"))
                return TestLLM.text("title", "title");
              return step++ === 0
                ? tool === "wait"
                  ? TestLLM.tool("waiting", "wait", { seconds: 600 })
                  : TestLLM.tool("draft", "send", { text: "unsent draft" })
                : TestLLM.text("done", "answer");
            });
            const host = yield* startScriptedMessagingHost(
              root,
              personaDirectory,
              llm,
              fake.messages,
              {
                ...fakeGestures().gestures,
                typing: () => Effect.as(Effect.sleep("10 minutes"), true),
              },
            );
            const session = yield* host.createSession("persona1");
            const handle = "interrupt@example.com";
            yield* bindConversation(host, handle, session.id);
            const original = yield* fake.text(handle, "original", Date.now());
            yield* host.sessions.wait(session.id).pipe(Effect.timeout("3 seconds"));
            step = 0;
            const arrival = yield* Effect.forkScoped(
              Effect.gen(function* () {
                while (
                  !JSON.stringify(
                    yield* host.sessions.messages({ sessionID: session.id }),
                  ).includes('"status":"running"')
                ) {
                  yield* Effect.sleep("20 millis");
                }
                yield* Effect.sleep("50 millis");
                if (change === "tapback")
                  yield* fake.text(handle, "", Date.now(), {
                    tapback: { emoji: "👍", targetGuid: original.guid, added: true },
                  });
                else if (change === "edit") yield* fake.edit(original.guid, "changed");
                else yield* fake.unsend(original.guid);
              }),
            );
            yield* host.sessions.prompt({ sessionID: session.id, text: "start" });
            yield* Fiber.join(arrival);
            yield* host.sessions.wait(session.id).pipe(Effect.timeout("4 seconds"));
            const transcript = JSON.stringify(
              yield* host.sessions.messages({ sessionID: session.id }),
            );
            expect(transcript).toContain(
              tool === "wait" ? "cut short by something new" : "not sent: a new message arrived",
            );
            if (change === "tapback") expect(transcript).toContain("<tapback");
            expect(fake.bubbles).toEqual([]);
          }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
        ),
      );
    } finally {
      await cleanup();
    }
  },
  12000,
);
