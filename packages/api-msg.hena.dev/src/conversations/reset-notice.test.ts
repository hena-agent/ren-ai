import { Effect } from "effect";
import { expect, test } from "vitest";
import { bindTestHandle, currentMemory, resetFixture } from "../../test/reset.test-helper.ts";
import { quietTestHost } from "../../test/messaging-host.test-helper.ts";
import { noticeCopy } from "../onboarding/onboarding.ts";

test("each reset sends its own Notice even beside an older Notice, a user's quote or a manual message", async () => {
  const f = await resetFixture("reset-notice-");
  const send = f.fake.messages.sendText.bind(f.fake.messages);
  f.fake.messages.sendText = (handle, text) => send(handle, text).pipe(Effect.as({ guid: null }));
  try {
    await f.run(
      Effect.gen(function* () {
        yield* f.startMarked;
        const at = Date.now();
        yield* f.fake.text(f.handle, "/reset", at);
        yield* f.fake.replace(
          (yield* f.fake.messages.after(0)).map((row) => ({ ...row, createdAt: at })),
        );
        yield* f.fake.text(f.handle, "/reset", at);
        expect(f.fake.bubbles).toHaveLength(2);
      }),
    );
    await Effect.runPromise(f.fake.text(f.handle, "/reset", Date.now()));
    await Effect.runPromise(f.fake.text(f.handle, noticeCopy.ko, Date.now()));
    await Effect.runPromise(f.fake.outgoing(f.handle, "manual message", Date.now()));
    await f.run(
      Effect.gen(function* () {
        const host = yield* f.start;
        const memory = yield* currentMemory(host, f.handle);
        expect(f.fake.bubbles).toHaveLength(3);
        expect(memory.text).toContain(`>${noticeCopy.ko}</message>`);
        expect(memory.text).toContain("manual message");
      }),
    );
  } finally {
    await f.cleanup();
  }
});

test("redelivery finishes a reset whose Notice lookup failed without another session", async () => {
  const f = await resetFixture("reset-retry-");
  let fail = true;
  try {
    await f.run(
      Effect.gen(function* () {
        const host = yield* quietTestHost(f.root, f.personaDirectory, {
          ...f.fake.messages,
          recent: (handle, since) =>
            Effect.suspend(() => {
              if (fail) {
                fail = false;
                return Effect.fail(new Error("Messages offline"));
              }
              return f.fake.messages.recent(handle, since);
            }),
        });
        yield* Effect.addFinalizer(() => Effect.promise(host.disposeOnboarding));
        yield* bindTestHandle(host, f.handle);
        expect(yield* f.fake.text(f.handle, "/reset", Date.now()).pipe(Effect.flip)).toEqual(
          new Error("Messages offline"),
        );
        const allocated = (yield* host.conversations.byHandle(f.handle))!.sessionID;
        const [command] = yield* f.fake.messages.after(0);
        yield* f.fake.redeliver(command!);
        const memory = yield* currentMemory(host, f.handle);
        expect(memory.id).toBe(allocated);
        expect(memory.text).toContain("<conversation-started");
        expect(f.fake.bubbles).toHaveLength(1);
      }),
    );
  } finally {
    await f.cleanup();
  }
});
