import { join } from "node:path";
import { Deferred, Effect } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { Session } from "@opencode/schema/session";
import { expect, test } from "vitest";
import { scriptedPersona, startTestHost } from "../../test/messaging-host.test-helper.ts";
import { resetFixture, bindTestHandle, currentMemory } from "../../test/reset.test-helper.ts";

test("startup does not reinterpret a reset already passed by the bookmark before the User joined", async () => {
  const f = await resetFixture("reset-bookmark-");
  try {
    await Effect.runPromise(f.fake.text(f.handle, "/reset", Date.now()));
    const original = await f.run(
      f.startMarked.pipe(
        Effect.flatMap((host) => currentMemory(host, f.handle)),
        Effect.map((memory) => memory.id),
      ),
    );
    await f.run(
      Effect.gen(function* () {
        const host = yield* f.start;
        expect((yield* currentMemory(host, f.handle)).id).toBe(original);
        expect(f.fake.bubbles).toEqual([]);
      }),
    );
  } finally {
    await f.cleanup();
  }
});

test("restart and a missing session cannot restore pre-reset Memory, including an offline reset", async () => {
  const { start, run, fake, handle, cleanup } = await resetFixture("reset-restart-");
  try {
    const original = await run(
      Effect.gen(function* () {
        const host = yield* start;
        const old = yield* bindTestHandle(host, handle);
        yield* fake.text(handle, "first secret", Date.now());
        yield* host.sessions.wait(old.id);
        return old.id;
      }),
    );
    const reset = await Effect.runPromise(fake.text(handle, "/reset", Date.now()));
    await Effect.runPromise(fake.text(handle, "new identity", Date.now()));
    await run(
      Effect.gen(function* () {
        const host = yield* start;
        const { id, text } = yield* currentMemory(host, handle);
        expect(id).not.toBe(original);
        expect((yield* host.sessions.get(original)).title).toContain(" · reset ");
        expect(text).not.toContain("first secret");
        yield* host.sessions.remove(id);
      }),
    );
    await run(
      Effect.gen(function* () {
        const host = yield* start;
        const { id, text: memory } = yield* currentMemory(host, handle);
        expect(memory).toContain("new identity");
        expect(memory).not.toContain("first secret");
        expect(memory).not.toContain("/reset");
        yield* fake.redeliver(reset);
        expect((yield* host.conversations.byHandle(handle))!.sessionID).toBe(id);
        yield* host.sessions.remove(id);
      }),
    );
    await Effect.runPromise(fake.text(handle, "/reset", Date.now()));
    await Effect.runPromise(fake.text(handle, "third identity", Date.now()));
    await run(
      Effect.gen(function* () {
        const host = yield* start;
        const { text: memory } = yield* currentMemory(host, handle);
        expect(memory).toContain("third identity");
        expect(memory).not.toContain("new identity");
        expect(memory).not.toContain("/reset");
      }),
    );
  } finally {
    await cleanup();
  }
});

test.each([false, true, "missing"] as const)(
  "a restart completes a reset interrupted around its Notice (delivered: %s) without replacing the new session again",
  async (delivered) => {
    const { root, personaDirectory, start, run, fake, handle, cleanup } =
      await resetFixture("reset-interrupted-");
    try {
      const fresh = await run(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const llm = yield* scriptedPersona();
          yield* llm.serve(() => TestLLM.text("quiet", "answer"));
          const host = yield* startTestHost(
            root,
            personaDirectory,
            llm,
            {
              ...fake.messages,
              sendText: (target, text) =>
                Effect.gen(function* () {
                  if (delivered === true) yield* fake.messages.sendText(target, text);
                  yield* Deferred.succeed(entered, undefined);
                  return yield* Effect.never;
                }),
            },
            join(root, "opencode.sqlite"),
          );
          yield* Effect.addFinalizer(() => Effect.promise(host.disposeOnboarding));
          yield* bindTestHandle(host, handle);
          yield* fake.text(handle, "/reset", Date.now()).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          const allocated = (yield* host.conversations.byHandle(handle))!.sessionID;
          if (delivered === "missing") yield* host.sessions.remove(Session.ID.make(allocated));
          return allocated;
        }),
      );
      await run(
        Effect.gen(function* () {
          const host = yield* start;
          const memory = yield* currentMemory(host, handle);
          if (delivered === "missing") expect(memory.id).not.toBe(fresh);
          else expect(memory.id).toBe(fresh);
          expect(memory.text).toContain("<conversation-started");
          expect((yield* host.sessions.list()).data).toHaveLength(2);
          expect(fake.bubbles).toHaveLength(1);
        }),
      );
    } finally {
      await cleanup();
    }
  },
);
