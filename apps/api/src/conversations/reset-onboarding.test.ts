import { Deferred, Effect, Fiber } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test, vi } from "vitest";
import {
  bindTestHandle,
  currentMemory,
  onboardTestHandle,
  resetFixture,
} from "../../test/reset.test-helper.ts";

test.each(["i@ysm.dev", "+821092836686"])(
  "%s can onboard from the beginning after reset",
  async (handle) => {
    const f = await resetFixture("reset-onboarding-");
    try {
      await f.run(
        Effect.gen(function* () {
          const host = yield* f.start;
          const sql = yield* SqlClient.SqlClient;
          yield* host.operator.testHandle(handle, true);
          expect(yield* onboardTestHandle(host, handle)).toBe("sent");
          yield* f.fake.text(handle, "old memory", Date.now());
          const old = yield* currentMemory(host, handle);
          const command = yield* f.fake.text(handle, " /RESET ", Date.now());
          expect(yield* host.conversations.byHandle(handle)).toBeUndefined();
          expect(yield* sql`SELECT id FROM user WHERE handle = ${handle}`).toEqual([]);
          expect(f.fake.bubbles).toHaveLength(1);
          expect((yield* host.sessions.get(old.id)).title).toContain(" · reset ");
          expect((yield* host.sessions.list()).data).toHaveLength(1);
          yield* f.fake.redeliver(command);
          expect(yield* onboardTestHandle(host, handle)).toBe("sent");
          const fresh = yield* currentMemory(host, handle);
          expect(fresh.id).not.toBe(old.id);
          expect(fresh.text).toContain("<conversation-started");
          expect(fresh.text).not.toContain("old memory");
          expect(fresh.text).not.toContain("/RESET");
          expect(f.fake.bubbles).toHaveLength(2);
          expect(yield* sql`SELECT replied_at FROM user WHERE handle = ${handle}`).toEqual([
            { replied_at: null },
          ]);
          yield* f.fake.redeliver(command);
          expect((yield* currentMemory(host, handle)).id).toBe(fresh.id);
          expect(yield* onboardTestHandle(host, handle)).toBe("sent");
          expect(f.fake.bubbles).toHaveLength(2);
        }),
      );
    } finally {
      await f.cleanup();
    }
  },
);

test("redelivery completes interrupted retention once and leaves later operator review work intact", async () => {
  const f = await resetFixture("reset-redelivery-");
  try {
    await f.run(
      Effect.gen(function* () {
        const host = yield* f.start;
        const sql = yield* SqlClient.SqlClient;
        const old = yield* bindTestHandle(host, f.handle);
        const entered = yield* Deferred.make<void>();
        const rename = vi
          .spyOn(host.sessions, "rename")
          .mockImplementationOnce(() =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          );
        const resetting = yield* f.fake
          .text(f.handle, "/reset", Date.now())
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        rename.mockRestore();
        yield* Fiber.interrupt(resetting);
        expect(yield* onboardTestHandle(host, f.handle)).toBe("unknown");
        const [command] = yield* f.fake.messages.after(0);
        yield* f.fake.redeliver(command!);
        expect(yield* sql`SELECT complete FROM reset`).toEqual([{ complete: 1 }]);
        expect(yield* onboardTestHandle(host, f.handle)).toBe("sent");
        const fresh = yield* currentMemory(host, f.handle);
        const review = yield* host.sessions.prompt({
          sessionID: old.id,
          text: "operator review notes",
          resume: false,
        });
        const rows = yield* f.fake.messages.after(0);
        yield* f.fake.redeliver({ ...command!, id: rows.at(-1)!.id + 1 });
        expect((yield* currentMemory(host, f.handle)).id).toBe(fresh.id);
        expect((yield* host.sessions.inbox(old.id)).map((item) => item.id)).toEqual([review.id]);
        expect(f.fake.bubbles).toHaveLength(1);
      }),
    );
  } finally {
    await f.cleanup();
  }
});

test.each(["late-guid", null])(
  "a late retired send is excluded from live Memory and replay (GUID: %s)",
  async (guid) => {
    const f = await resetFixture("reset-late-send-");
    try {
      await f.run(
        Effect.gen(function* () {
          const host = yield* f.startMarked;
          const sql = yield* SqlClient.SqlClient;
          const old = (yield* host.conversations.byHandle(f.handle))!;
          yield* sql`INSERT INTO send (handle, conversation_id, kind, content, state, guid, recorded_at, updated_at)
        VALUES (${f.handle}, ${old.id}, 'text', 'retired bubble', 'uncertain', ${guid}, 1, 1)`;
          yield* f.fake.text(f.handle, "/reset", Date.now());
          yield* onboardTestHandle(host, f.handle);
          yield* f.fake.outgoing(
            f.handle,
            guid ? "retired bubble edited" : "retired bubble",
            Date.now(),
            "sent",
            "late-guid",
          );
          expect((yield* currentMemory(host, f.handle)).text).not.toContain("retired bubble");
          yield* host.operator.rebuild(f.handle);
          expect((yield* currentMemory(host, f.handle)).text).not.toContain("retired bubble");
        }),
      );
    } finally {
      await f.cleanup();
    }
  },
);
