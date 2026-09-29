import { rm } from "node:fs/promises";
import { Clock, Duration, Effect } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { Session } from "@opencode/schema/session";
import { expect, test } from "vitest";
import {
  messagingFixture,
  runMessagingTest,
  scriptedPersona,
  startTestHost,
} from "../../test/messaging-host.test-helper.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { bindTestHandle } from "../../test/reset.test-helper.ts";

test("sending the reset Greeting does not schedule a follow-up until the User replies", async () => {
  const { root, personaDirectory } = await messagingFixture("reset-follow-");
  const fake = fakeMessages();
  const handle = "tester@example.com";
  let offset = 0;
  const clock = Effect.runSync(Clock.Clock);
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const llm = yield* scriptedPersona();
        let greet = false;
        yield* llm.serve(() => {
          if (!greet) return TestLLM.text("quiet", "answer");
          greet = false;
          return TestLLM.tool("greeting", "send", { text: "Hello stranger" });
        });
        const host = yield* startTestHost(root, personaDirectory, llm, fake.messages);
        yield* Effect.addFinalizer(() => Effect.promise(host.disposeOnboarding));
        const old = yield* bindTestHandle(host, handle);
        yield* fake.text(handle, "old reply", yield* Clock.currentTimeMillis);
        yield* host.sessions.wait(old.id);
        greet = true;
        yield* fake.text(handle, "/reset", yield* Clock.currentTimeMillis);
        const id = Session.ID.make((yield* host.conversations.byHandle(handle))!.sessionID);
        yield* host.sessions.wait(id);
        expect(fake.bubbles).toContainEqual({ handle, text: "Hello stranger" });
        offset += 8 * 86_400_000;
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
        yield* host.sessions.wait(id);
        expect(JSON.stringify(yield* host.sessions.messages({ sessionID: id }))).not.toContain(
          "<checked-phone",
        );
        yield* fake.text(handle, "new reply", yield* Clock.currentTimeMillis);
        yield* host.sessions.wait(id);
        offset += 3 * 86_400_000;
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
        yield* host.sessions.wait(id);
        expect(JSON.stringify(yield* host.sessions.messages({ sessionID: id }))).toContain(
          "<checked-phone",
        );
      }).pipe(
        Effect.provideService(Clock.Clock, {
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          currentTimeNanos: clock.currentTimeNanos,
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: clock.monotonicTimeNanos,
          currentTimeMillisUnsafe: () => Date.now() + offset,
          currentTimeMillis: Effect.sync(() => Date.now() + offset),
          // Preserve OpenCode's exact daily plugin refresh; compress only follow-up waits.
          sleep: (duration) =>
            clock.sleep(Duration.toMillis(duration) > 86_400_000 ? Duration.millis(10) : duration),
        }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
