import { Deferred, Effect, Fiber, Option } from "effect";
import { Session } from "@opencode/schema";
import { expect, test } from "vitest";
import { resets } from "../conversations/reset.ts";
import {
  catalogTest,
  authoredDefinition,
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
        const reset = yield* resets(host.directory, () => Effect.void, host.fake.messages);
        const updated = authoredDefinition({
          ...host.personas.get("persona1")!,
          name: "수아 수정",
          prompt: "You treasure the violet notebook.",
        });
        const gate = yield* beginCatalogEdit(host, fixture, updated);
        const mutation =
          action === "reset"
            ? Effect.flatMap(
                host.fake.text("active@example.com", "/reset", Date.now()),
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
          fixture.store.update(
            authoredDefinition({ ...updated, prompt: "An edit only for ongoing conversations." }),
          ),
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
      yield* host.fake.text("active@example.com", "Remember my name is Mina.", Date.now());
      const old = host.personas.get("persona1")!;
      const gate = yield* pauseFolderWrite(host, old.prompt.trim());
      const rebuilding = yield* host.recovery
        .rebuild("active@example.com", true)
        .pipe(Effect.forkScoped);
      yield* gate.entered;
      const updated = authoredDefinition({
        ...old,
        name: "수아 수정",
        prompt: "You saved the silver ticket.",
      });
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
      const contacting = yield* host.firstContact("greeting@example.com").pipe(Effect.forkScoped);
      yield* gate.entered;
      const updated = authoredDefinition({
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "You remember the emerald bicycle.",
      });
      yield* Effect.promise(() => fixture.store.update(updated));
      yield* host.watch();
      yield* expectBoundPersona(host, "greeting@example.com", updated);
      yield* gate.release;
      yield* Fiber.join(contacting);
      expect((yield* host.directory.byHandle("greeting@example.com"))?.personaID).toBe("persona1");
    }),
  ),
);

test(
  "a rebuild waiting for Messages history does not hold the catalog lifecycle lock",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      yield* host.activeSession();
      const { entered, release } = yield* barrier;
      const recent = host.fake.messages.recent.bind(host.fake.messages);
      host.fake.messages.recent = (...args) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return yield* recent(...args);
        });
      const rebuilding = yield* host.recovery
        .rebuild("active@example.com", true)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"));
      const updated = authoredDefinition({
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "You like the quiet observatory.",
      });
      yield* Effect.promise(() => fixture.store.update(updated));
      yield* host.watch();
      yield* expectBoundPersona(host, "active@example.com", updated);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(rebuilding)).toBe("rebuilt");
    }),
  ),
);

test(
  "a catalog edit during first-contact allocation still reaches the newly bound native folder without a second edit",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const old = host.personas.get("persona1")!;
      const gate = yield* pauseFolderWrite(host, old.prompt.trim());
      const contacting = yield* host.firstContact("joining@example.com").pipe(Effect.forkScoped);
      yield* gate.entered;
      const updated = authoredDefinition({
        ...old,
        name: "수아 수정",
        prompt: "You collect tiny ceramic birds.",
      });
      yield* Effect.promise(() => fixture.store.update(updated));
      yield* host.watch();
      yield* expectProfile(host, "수아 수정");
      yield* gate.release;
      yield* Fiber.join(contacting);
      const conversation = (yield* host.directory.byHandle("joining@example.com"))!;
      expect(conversation.personaID).toBe("persona1");
      yield* expectPrompt(host, conversation.sessionID, updated.prompt);
    }),
  ),
);
