import { Deferred, Effect } from "effect";
import { expect, test, vi } from "vitest";
import {
  resetFixture,
  bindTestHandle,
  currentMemory,
  onboardTestHandle,
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
        yield* onboardTestHandle(host, handle);
        yield* fake.text(handle, "new identity after onboarding", Date.now());
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
        yield* onboardTestHandle(host, handle);
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
  "a restart completes interrupted session retention before allowing onboarding (old session missing: %s)",
  async (missing) => {
    const { start, run, fake, handle, cleanup } = await resetFixture("reset-interrupted-");
    try {
      const old = await run(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const host = yield* start;
          const original = yield* bindTestHandle(host, handle);
          const rename = vi
            .spyOn(host.sessions, "rename")
            .mockImplementationOnce(() =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            );
          yield* fake.text(handle, "/reset", Date.now()).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          rename.mockRestore();
          expect(yield* host.conversations.byHandle(handle)).toBeUndefined();
          expect(yield* onboardTestHandle(host, handle)).toBe("unknown");
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
          yield* onboardTestHandle(host, handle);
          const memory = yield* currentMemory(host, handle);
          expect(memory.id).not.toBe(old);
          expect(memory.text).toContain("<conversation-started");
          expect((yield* host.sessions.list()).data).toHaveLength(missing ? 1 : 2);
          expect(fake.bubbles).toHaveLength(1);
        }),
      );
    } finally {
      await cleanup();
    }
  },
);

test("an upgrade finishes a legacy memory-only reset and excludes its previous Notice", async () => {
  const f = await resetFixture("reset-upgrade-");
  try {
    await f.run(
      Effect.gen(function* () {
        const host = yield* f.startMarked;
        const sql = yield* SqlClient.SqlClient;
        const old = yield* currentMemory(host, f.handle);
        const allocated = yield* host.createSession("persona1");
        yield* sql`INSERT INTO send (handle, kind, content, state, recorded_at, updated_at)
        VALUES (${f.handle}, 'notice', 'old', 'sent', 1, 1)`;
        yield* sql`INSERT INTO retained_session (session_id, handle, title)
        VALUES (${old.id}, ${f.handle}, 'old reset session')`;
        yield* sql`INSERT INTO reset (guid, handle, row_id, date, session_id)
        VALUES ('legacy-reset', ${f.handle}, 1, 2, ${allocated.id})`;
        yield* sql`UPDATE conversation SET session_id = ${allocated.id}, reset_guid = 'legacy-reset'`;
        yield* sql`ALTER TABLE reset DROP COLUMN notice_id`;
        yield* sql`ALTER TABLE user DROP COLUMN persona_id`;
        yield* sql`DROP TABLE discovery_like`;
        yield* sql`DROP TABLE discovery_registration`;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 16`;
      }),
    );
    await f.run(
      Effect.gen(function* () {
        const host = yield* f.start;
        const sql = yield* SqlClient.SqlClient;
        expect(yield* host.conversations.byHandle(f.handle)).toBeUndefined();
        expect(yield* sql`SELECT complete, notice_id FROM reset`).toEqual([
          { complete: 1, notice_id: 1 },
        ]);
        expect(yield* onboardTestHandle(host, f.handle)).toBe("sent");
        expect(f.fake.bubbles).toHaveLength(1);
        expect((yield* currentMemory(host, f.handle)).text).toContain("<conversation-started");
      }),
    );
  } finally {
    await f.cleanup();
  }
});
