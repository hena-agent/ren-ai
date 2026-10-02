import { Effect } from "effect";
import { expect, test } from "vitest";
import { currentMemory, resetFixture, onboardTestHandle } from "../../test/reset.test-helper.ts";
import { quietTestHost } from "../../test/messaging-host.test-helper.ts";
import { noticeCopy } from "../onboarding/onboarding.ts";

test("onboarding after each reset sends a new Notice despite the retained Notice audit", async () => {
  const f = await resetFixture("reset-notice-");
  const send = f.fake.messages.sendText.bind(f.fake.messages);
  f.fake.messages.sendText = (handle, text) => send(handle, text).pipe(Effect.as({ guid: null }));
  try {
    await f.run(
      Effect.gen(function* () {
        const host = yield* f.startMarked;
        const at = Date.now();
        yield* f.fake.text(f.handle, "/reset", at);
        yield* onboardTestHandle(host, f.handle);
        yield* f.fake.replace(
          (yield* f.fake.messages.after(0)).map((row) => ({ ...row, createdAt: at })),
        );
        yield* f.fake.text(f.handle, "/reset", at);
        yield* onboardTestHandle(host, f.handle);
        expect(f.fake.bubbles).toHaveLength(2);
      }),
    );
    await Effect.runPromise(f.fake.text(f.handle, "/reset", Date.now()));
    await f.run(
      Effect.gen(function* () {
        const host = yield* f.start;
        yield* onboardTestHandle(host, f.handle);
        yield* f.fake.text(f.handle, noticeCopy.ko, Date.now());
        yield* f.fake.outgoing(f.handle, "manual message", Date.now());
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

test("redelivery retries a failed reset boundary lookup without another session or Notice", async () => {
  const f = await resetFixture("reset-retry-");
  let fail = false;
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
        yield* host.operator.testHandle(f.handle, true);
        yield* onboardTestHandle(host, f.handle);
        yield* f.fake.text(f.handle, "/reset", Date.now());
        yield* onboardTestHandle(host, f.handle);
        fail = true;
        expect(yield* f.fake.text(f.handle, "/reset", Date.now()).pipe(Effect.flip)).toEqual(
          new Error("Messages offline"),
        );
        const allocated = (yield* host.conversations.byHandle(f.handle))!.sessionID;
        const command = (yield* f.fake.messages.after(0)).at(-1);
        yield* f.fake.redeliver(command!);
        expect(yield* host.conversations.byHandle(f.handle)).toBeUndefined();
        yield* onboardTestHandle(host, f.handle);
        const memory = yield* currentMemory(host, f.handle);
        expect(memory.id).not.toBe(allocated);
        expect(memory.text).toContain("<conversation-started");
        expect(f.fake.bubbles).toHaveLength(3);
      }),
    );
  } finally {
    await f.cleanup();
  }
});
