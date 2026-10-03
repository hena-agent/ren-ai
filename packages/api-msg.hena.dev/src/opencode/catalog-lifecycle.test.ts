import { Deferred, Effect, Fiber, Option } from "effect";
import { Session } from "@opencode/schema";
import { expect, test } from "vitest";
import { resets } from "../conversations/reset.ts";
import { makeOperator } from "../operator/operator.ts";
import {
  catalogTest,
  expectProfile,
  expectPrompt,
  pauseFolderWrite,
  pauseGreeting,
  barrier,
  editDuringAllocation,
  expectBoundPersona,
  markedOperator,
  beginCatalogEdit,
} from "./catalog-sync.test-helper.ts";

test.each(["reset", "remove"] as const)(
  "%s waits for an in-flight catalog scan/write, so the retained snapshot never changes afterwards",
  (action) =>
    catalogTest((host, fixture) =>
      Effect.gen(function* () {
        const active = yield* host.activeSession();
        const operator = yield* markedOperator(host);
        const reset = yield* resets(
          host.directory,
          host.remote,
          () => Effect.void,
          host.api.fake.messages,
        );
        const updated = {
          ...host.personas.get("persona1")!,
          name: "수아 수정",
          prompt: "You treasure the violet notebook.",
        };
        const gate = yield* beginCatalogEdit(host, fixture, updated);
        const mutation =
          action === "reset"
            ? Effect.flatMap(
                host.api.fake.text("active@example.com", "/reset", Date.now()),
                reset.receive,
              )
            : operator.remove("active@example.com");
        const resetting = yield* mutation.pipe(Effect.forkScoped);
        const beforeWrite = yield* Effect.timeoutOption(Fiber.await(resetting), "200 millis");
        expect(Option.isNone(beforeWrite)).toBe(true);
        yield* gate.release;
        yield* Fiber.join(resetting);
        yield* expectProfile(host, "수아 수정");
        const snapshot = yield* host.read(active.id);
        expect(snapshot.persona.prompt).toBe(updated.prompt);
        yield* Effect.promise(() =>
          fixture.store.update({ ...updated, prompt: "An edit only for ongoing conversations." }),
        );
        yield* Effect.sleep("200 millis");
        expect(yield* host.read(active.id)).toEqual(snapshot);
        expect(yield* host.directory.byHandle("active@example.com")).toBeUndefined();
        yield* operator.testHandle("active@example.com", false);
        expect(yield* operator.remove("active@example.com")).toBe("removed");
        expect(yield* host.read(active.id).pipe(Effect.flip)).toMatchObject({
          message: "Cannot read session folder",
        });
      }),
    )(),
);

test(
  "catalog synchronization waits for rebuild allocation and includes the replacement folder in that same edit",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const active = yield* host.activeSession();
      yield* host.api.fake.text("active@example.com", "Remember my name is Mina.", Date.now());
      const old = host.personas.get("persona1")!;
      const gate = yield* pauseFolderWrite(host, old.prompt.trim());
      const rebuilding = yield* host.recovery
        .rebuild("active@example.com", true)
        .pipe(Effect.forkScoped);
      yield* gate.entered;
      const updated = { ...old, name: "수아 수정", prompt: "You saved the silver ticket." };
      yield* editDuringAllocation(host, fixture, gate, updated);
      expect(yield* Fiber.join(rebuilding)).toBe("rebuilt");
      yield* expectProfile(host, "수아 수정");
      const current = (yield* host.directory.byHandle("active@example.com"))!;
      expect(current.sessionID).not.toBe(active.id);
      yield* expectPrompt(host, current.sessionID, updated.prompt);
      expect(
        JSON.stringify(
          yield* host.remote.sessions.messages({
            sessionID: Session.ID.make(current.sessionID),
          }),
        ),
      ).toContain("Remember my name is Mina.");
    }),
  ),
);

test(
  "a pending greeting does not prevent a catalog update from refreshing its already bound session",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const gate = yield* pauseGreeting(host);
      const submitting = yield* host.api
        .submit("greeting@example.com", "persona1")
        .pipe(Effect.forkScoped);
      yield* gate.entered;
      const updated = {
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "You remember the emerald bicycle.",
      };
      yield* Effect.promise(() => fixture.store.update(updated));
      yield* host.watch();
      yield* expectBoundPersona(host, "greeting@example.com", updated);
      yield* gate.release;
      expect(yield* Fiber.join(submitting)).toBe("sent");
    }),
  ),
);

test(
  "a rebuild waiting for Messages history does not hold the catalog lifecycle lock",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      yield* host.activeSession();
      const { entered, release } = yield* barrier;
      const after = host.api.fake.messages.after.bind(host.api.fake.messages);
      host.api.fake.messages.after = (cursor) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return yield* after(cursor);
        });
      const rebuilding = yield* host.recovery
        .rebuild("active@example.com", true)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"));
      const updated = {
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "You like the quiet observatory.",
      };
      yield* Effect.promise(() => fixture.store.update(updated));
      yield* host.watch();
      yield* expectBoundPersona(host, "active@example.com", updated);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(rebuilding)).toBe("rebuilt");
    }),
  ),
);

test(
  "removing a pending user while Messages status is in flight never allocates a session for that removed user",
  catalogTest((host) =>
    Effect.gen(function* () {
      const { entered, release } = yield* barrier;
      const status = host.api.fake.messages.textStatus.bind(host.api.fake.messages);
      host.api.fake.messages.textStatus = (handle, since) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return yield* status(handle, since);
        });
      const submitting = yield* host.api
        .submit("removed@example.com", "persona1")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"));
      const operator = yield* makeOperator(host.directory, (id) =>
        host.remote.sessions.remove(Session.ID.make(id)),
      );
      expect(yield* operator.remove("removed@example.com")).toBe("removed");
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(submitting)).toBe("unknown");
      expect(yield* host.directory.byHandle("removed@example.com")).toBeUndefined();
    }),
  ),
);

test(
  "two status watchers recovering the same pending onboarding can bind only one native session",
  catalogTest((host) =>
    Effect.gen(function* () {
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      const status = host.api.fake.messages.textStatus.bind(host.api.fake.messages);
      let checks = 0;
      let allocations = 0;
      host.transport.before = (request) => {
        if (new URL(request.url).pathname.endsWith("/ren-ai.session-folders/create")) allocations++;
        return Promise.resolve();
      };
      host.api.fake.messages.textStatus = (handle, since) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(++checks === 1 ? first : second, undefined);
          yield* Deferred.await(release);
          return yield* status(handle, since);
        });
      const submitting = yield* host.api
        .submit("twice@example.com", "persona1")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(first).pipe(Effect.timeout("5 seconds"));
      yield* host.api.api.resume;
      yield* Deferred.await(second).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(submitting)).toBe("sent");
      yield* Effect.sleep("100 millis");
      expect(allocations).toBe(1);
      expect((yield* host.directory.byHandle("twice@example.com"))?.personaID).toBe("persona1");
    }),
  ),
);

test(
  "catalog publication waits for onboarding allocation and then refreshes the newly bound native folder without a second edit",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const old = host.personas.get("persona1")!;
      const gate = yield* pauseFolderWrite(host, old.prompt.trim());
      const submitting = yield* host.api
        .submit("joining@example.com", "persona1")
        .pipe(Effect.forkScoped);
      yield* gate.entered;
      const updated = { ...old, name: "수아 수정", prompt: "You collect tiny ceramic birds." };
      yield* editDuringAllocation(host, fixture, gate, updated);
      expect(yield* Fiber.join(submitting)).toBe("sent");
      yield* expectProfile(host, "수아 수정");
      const conversation = (yield* host.directory.byHandle("joining@example.com"))!;
      yield* expectPrompt(host, conversation.sessionID, updated.prompt);
    }),
  ),
);
