import { Deferred, Effect, Fiber } from "effect";
import { expect, test } from "vitest";
import { bindTestHandle, currentMemory, resetFixture } from "../../test/reset.test-helper.ts";
import { quietTestHost } from "../../test/messaging-host.test-helper.ts";

test("an edit waiting behind a reset cannot be admitted to the retired session", async () => {
  const f = await resetFixture("reset-race-");
  try {
    await f.run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const inspected = yield* Deferred.make<void>();
        let hold = false;
        const host = yield* quietTestHost(f.root, f.personaDirectory, {
          ...f.fake.messages,
          recent: (handle, since) =>
            Effect.gen(function* () {
              if (hold && since === 0) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              } else if (hold) yield* Deferred.succeed(inspected, undefined);
              return yield* f.fake.messages.recent(handle, since);
            }),
        });
        yield* Effect.addFinalizer(() => Effect.promise(host.disposeOnboarding));
        yield* bindTestHandle(host, f.handle);
        yield* f.fake.text(f.handle, "/reset", Date.now());
        const old = yield* currentMemory(host, f.handle);
        const message = yield* f.fake.text(f.handle, "before second reset", Date.now());
        yield* host.sessions.wait(old.id);
        hold = true;
        const resetting = yield* f.fake
          .text(f.handle, "/reset", Date.now())
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* f.fake.edit(message.guid, "racing edit");
        yield* Deferred.await(inspected);
        yield* Effect.sleep("30 millis");
        hold = false;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(resetting);
        yield* host.sessions.wait(old.id);
        expect(JSON.stringify(yield* host.sessions.messages({ sessionID: old.id }))).not.toContain(
          "racing edit",
        );
        const fresh = yield* currentMemory(host, f.handle);
        expect(fresh.id).not.toBe(old.id);
        expect(fresh.text).not.toContain("racing edit");
      }).pipe(Effect.timeout("15 seconds")),
    );
  } finally {
    await f.cleanup();
  }
}, 20_000);
