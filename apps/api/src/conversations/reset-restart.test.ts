import { Deferred, Effect } from "effect";
import { expect, test, vi } from "vitest";
import {
  resetFixture,
  bindTestHandle,
  currentMemory,
  startTestHandle,
} from "../../test/reset.test-helper.ts";
import { SqlClient } from "effect/unstable/sql";

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
        expect(yield* host.conversations.byHandle(handle)).toBeUndefined();
        yield* startTestHandle(host, fake.messages, handle);
        yield* fake.text(handle, "new identity after onboarding", Date.now());
        const { id, text } = yield* currentMemory(host, handle);
        expect(id).not.toBe(original);
        expect((yield* host.sessions.get(original)).title).not.toContain(" · reset ");
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
        yield* startTestHandle(host, fake.messages, handle);
        yield* fake.text(handle, "third identity after onboarding", Date.now());
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

test.each([false, true])(
  "a restart resumes an interrupted relationship stop before reselection (old session missing: %s)",
  async (missing) => {
    const { start, run, fake, handle, cleanup } = await resetFixture("reset-interrupted-");
    try {
      const old = await run(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const host = yield* start;
          const original = yield* bindTestHandle(host, handle);
          const interrupt = vi
            .spyOn(host.sessions, "interrupt")
            .mockImplementationOnce(() =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            );
          yield* fake.text(handle, "/reset", Date.now());
          yield* host.heartbeat.stopped.pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          interrupt.mockRestore();
          expect(yield* host.conversations.byHandle(handle)).toBeUndefined();
          if (missing) yield* host.sessions.remove(original.id);
          return original.id;
        }),
      );
      await run(
        Effect.gen(function* () {
          const host = yield* start;
          expect(yield* host.conversations.byHandle(handle)).toBeUndefined();
          const sql = yield* SqlClient.SqlClient;
          expect(yield* sql`SELECT complete FROM reset`).toEqual([{ complete: 1 }]);
          yield* startTestHandle(host, fake.messages, handle);
          const memory = yield* currentMemory(host, handle);
          expect(memory.id).not.toBe(old);
          expect(memory.text).toContain("<conversation-started");
          expect((yield* host.sessions.list()).data).toHaveLength(missing ? 1 : 2);
          expect(fake.bubbles).toEqual([]);
        }),
      );
    } finally {
      await cleanup();
    }
  },
);

test("startup finishes a committed reset whose command is already behind the bookmark", async () => {
  const f = await resetFixture("reset-resume-");
  try {
    await f.run(
      Effect.gen(function* () {
        const host = yield* f.startMarked;
        yield* currentMemory(host, f.handle);
        yield* f.fake.text(f.handle, "/reset", Date.now());
      }),
    );
    await f.run(
      Effect.gen(function* () {
        const host = yield* f.start;
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT complete FROM reset`).toEqual([{ complete: 1 }]);
        expect(yield* startTestHandle(host, f.fake.messages, f.handle)).toBe("started");
        expect((yield* currentMemory(host, f.handle)).text).toContain("<conversation-started");
      }),
    );
  } finally {
    await f.cleanup();
  }
});
