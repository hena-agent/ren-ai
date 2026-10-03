import * as fs from "node:fs/promises";
import { join } from "node:path";
import { Session } from "@opencode/schema";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { Deferred, Effect, Fiber } from "effect";
import { expect, test, vi } from "vitest";
import { folderSession, withSessionFolders } from "../../test/session-folder.test-helper.ts";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

const pauseWrite = Effect.fn(function* (directory: string) {
  yield* Effect.addFinalizer(() => Effect.sync(() => vi.restoreAllMocks()));
  const entered = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const rename = fs.rename;
  let paused = false;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (!paused && String(to) === join(directory, "persona.json")) {
      paused = true;
      await Effect.runPromise(Deferred.succeed(entered, undefined));
      await Effect.runPromise(Deferred.await(release));
    }
    await rename(from, to);
  });
  return { entered, release };
});

test("native deletion during a folder update queues cleanup after the writer", () =>
  withSessionFolders((host) =>
    Effect.gen(function* () {
      const { session, snapshot } = yield* folderSession(host);
      const { entered, release } = yield* pauseWrite(session.location.directory);
      const update = yield* host.rpc
        .update(
          {
            folderID: session.id,
            snapshot: renderSnapshot(
              { ...snapshot.persona, prompt: "Changed during deletion." },
              snapshot.rules,
            ),
          },
          host.location,
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* host.remote.client.session.remove({ sessionID: session.id });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(update);
      yield* Effect.promise(async () => {
        await expect.poll(() => host.files.exists(session.id)).toBe(false);
      });
      expect(
        yield* host.rpc.update({ folderID: session.id, snapshot }, host.location).pipe(Effect.flip),
      ).toMatchObject({ message: "Cannot update session folder" });
      expect(yield* Effect.promise(() => host.files.exists(session.id))).toBe(false);
    }),
  ));

test("snapshot RPC reads wait for a complete multi-file update", () =>
  withSessionFolders((host) =>
    Effect.gen(function* () {
      const { session, snapshot } = yield* folderSession(host);
      const next = renderSnapshot(
        { ...snapshot.persona, prompt: "New metadata and agent." },
        "New rules.",
      );
      const { entered, release } = yield* pauseWrite(session.location.directory);
      const update = yield* host.rpc
        .update({ folderID: session.id, snapshot: next }, host.location)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const complete = Deferred.makeUnsafe<void>();
      const read = yield* host.rpc.read({ folderID: session.id }, host.location).pipe(
        Effect.tap(() => Deferred.succeed(complete, undefined)),
        Effect.forkScoped,
      );
      expect(yield* Effect.promise(() => host.files.read(session.id))).toEqual({
        ...next,
        persona: snapshot.persona,
      });
      expect(yield* Deferred.isDone(complete)).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(update);
      expect(yield* Fiber.join(read)).toEqual(next);
    }),
  ));

test("preparation drains delayed native deletion before restoring the same session ID", () => {
  const entered = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  return withSessionFolders(
    (host) =>
      Effect.gen(function* () {
        const { session, snapshot } = yield* folderSession(host);
        const exported = yield* host.remote.client.session.export({
          sessionID: session.id,
          sanitize: false,
        });
        yield* host.remote.client.session.create({
          id: Session.ID.make("ses_event_blocker"),
          location: session.location,
        });
        yield* Deferred.await(entered);
        yield* host.remote.client.session.remove({ sessionID: session.id });
        const prepared = yield* host.rpc
          .write({ folderID: session.id, snapshot }, host.location)
          .pipe(Effect.forkScoped);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(prepared);
        yield* host.remote.client.session.import({ ...exported, location: session.location });
        expect(yield* host.rpc.read({ folderID: session.id }, host.location)).toEqual(snapshot);
        expect((yield* host.remote.sessions.get(session.id)).location.directory).toBe(
          session.location.directory,
        );
      }),
    (ctx) => ({
      ...ctx,
      session: {
        ...ctx.session,
        get: (input: Parameters<typeof ctx.session.get>[0]) =>
          ctx.session.get(input).pipe(
            Effect.tap(() => {
              if (input.sessionID !== "ses_event_blocker") return Effect.void;
              return Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
              );
            }),
          ),
      },
    }),
  );
});

test("a disconnected create caller cannot interrupt server ownership between folder and session", () => {
  const entered = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  return withSessionFolders(
    (host) =>
      Effect.gen(function* () {
        const id = Session.ID.create();
        const snapshot = renderSnapshot(host.remote.personas.get("persona1")!, "Atomic ownership.");
        const create = yield* host.rpc
          .create({ folderID: id, snapshot, model: "test/probe" }, host.location)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const interrupted = yield* Fiber.interrupt(create).pipe(Effect.forkScoped);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupted);
        yield* Effect.promise(async () => {
          await expect
            .poll(async () => {
              const session = await Effect.runPromise(host.remote.sessions.get(id));
              return session.location.directory;
            })
            .toBe(host.files.path(id));
        });
        expect(yield* Effect.promise(() => host.files.exists(id))).toBe(true);
      }),
    (ctx) => ({
      ...ctx,
      session: {
        ...ctx.session,
        create: (input: Parameters<typeof ctx.session.create>[0]) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return yield* ctx.session.create(input);
          }),
      },
    }),
  );
});
