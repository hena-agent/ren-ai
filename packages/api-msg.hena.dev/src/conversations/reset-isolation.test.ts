import { rm } from "node:fs/promises";
import { Effect } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { Session } from "@opencode/schema/session";
import { expect, test } from "vitest";
import {
  messagingFixture,
  registration,
  runMessagingTest,
} from "../../test/messaging.test-helper.ts";
import { scriptedPersona, startTestHost } from "../../test/messaging-host.test-helper.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { onboardTestHandle } from "../../test/reset.test-helper.ts";

test.each([false, true])(
  "reset interrupts a waiting persona and fences edits (concurrent poll: %s)",
  async (concurrent) => {
    const { root, personaDirectory } = await messagingFixture("reset-isolation-");
    const fake = fakeMessages();
    const handle = "tester@example.com";
    let resetOnRead = false;
    try {
      await runMessagingTest(
        Effect.gen(function* () {
          const llm = yield* scriptedPersona();
          let pause = true;
          yield* llm.serve(() => {
            if (!pause) return TestLLM.text("done", "done");
            pause = false;
            return TestLLM.tool("long-wait", "wait", { minutes: 720 });
          });
          const host = yield* startTestHost(root, personaDirectory, llm, {
            ...fake.messages,
            recent: (target, since) =>
              Effect.gen(function* () {
                if (resetOnRead) {
                  resetOnRead = false;
                  yield* fake.text(handle, "/reset", Date.now());
                }
                return yield* fake.messages.recent(target, since);
              }),
          });
          yield* Effect.addFinalizer(() => Effect.promise(host.disposeOnboarding));
          const old = yield* host.createSession("persona1");
          yield* host.conversations.create(registration(handle, old.id));
          yield* host.operator.testHandle(handle, true);
          const message = yield* fake.text(handle, "remember this", Date.now());
          while (
            !JSON.stringify(yield* host.sessions.messages({ sessionID: old.id })).includes(
              '"status":"running"',
            )
          ) {
            yield* Effect.sleep("10 millis");
          }
          yield* host.sessions.prompt({
            sessionID: old.id,
            text: "queued before reset",
            delivery: "queue",
          });
          if (concurrent) {
            yield* fake.edit(message.guid, "changed before reset");
            resetOnRead = true;
            yield* Effect.sleep("1100 millis");
          } else yield* fake.text(handle, "/reset", Date.now());
          yield* onboardTestHandle(host, handle);
          const id = Session.ID.make((yield* host.conversations.byHandle(handle))!.sessionID);
          yield* host.sessions.wait(id);
          expect((yield* host.sessions.get(old.id)).outcome).toBe("interrupted");
          expect(yield* host.sessions.inbox(old.id)).toEqual([]);
          const before = yield* host.sessions.messages({ sessionID: old.id });
          expect(JSON.stringify(before)).not.toContain("changed before reset");
          yield* fake.edit(message.guid, "changed before reset");
          yield* fake.text(handle, "", Date.now(), {
            tapback: { emoji: "👍", targetGuid: message.guid, added: true },
          });
          yield* Effect.sleep("1100 millis");
          expect(yield* host.sessions.messages({ sessionID: old.id })).toEqual(before);
          expect(JSON.stringify(yield* host.sessions.messages({ sessionID: id }))).not.toContain(
            "remember this",
          );
          const reply = yield* fake.text(handle, "quoting intentionally", Date.now(), {
            replyToGuid: message.guid,
          });
          yield* host.sessions.wait(id);
          expect(JSON.stringify(yield* host.sessions.messages({ sessionID: id }))).toContain(
            "changed before reset",
          );
          yield* fake.edit(reply.guid, "edited after reset");
          yield* Effect.sleep("1100 millis");
          yield* host.sessions.wait(id);
          expect(JSON.stringify(yield* host.sessions.messages({ sessionID: id }))).toContain(
            "edited after reset",
          );
        }).pipe(Effect.timeout("10 seconds")),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
