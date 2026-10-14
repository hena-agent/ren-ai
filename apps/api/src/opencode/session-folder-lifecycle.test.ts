import { readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AbsolutePath, Agent, Model, Session } from "@opencode/schema";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { folderSnapshot } from "@ren-ai/plugin-session-folder/protocol";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { folderSession, withSessionFolders } from "../../test/session-folder.test-helper.ts";

test("creation owns its folder, is idempotent, and updates reject missing or mismatched sessions", () =>
  withSessionFolders((host) =>
    Effect.gen(function* () {
      const { session: original, snapshot } = yield* folderSession(host);
      const input = { folderID: original.id, snapshot, model: "test/probe" };
      expect(yield* host.rpc.create(input, host.location)).toBe(original.location.directory);
      expect(
        yield* host.rpc
          .create(
            {
              ...input,
              snapshot: renderSnapshot({ ...snapshot.persona, id: "different" }, snapshot.rules),
            },
            host.location,
          )
          .pipe(Effect.flip),
      ).toMatchObject({ message: "Cannot create persona session" });
      expect(
        yield* host.rpc
          .update(
            {
              ...input,
              snapshot: renderSnapshot({ ...snapshot.persona, id: "different" }, snapshot.rules),
            },
            host.location,
          )
          .pipe(Effect.flip),
      ).toMatchObject({ message: "Cannot update session folder" });
      const updated = renderSnapshot(
        { ...snapshot.persona, prompt: "Updated photographer." },
        "New rules.",
      );
      expect(
        yield* host.rpc.update({ folderID: original.id, snapshot: updated }, host.location),
      ).toBe(original.location.directory);
      expect(yield* host.rpc.read({ folderID: original.id }, host.location)).toEqual(updated);
      yield* host.remote.sessions.remove(original.id);
      expect(
        yield* host.rpc
          .update({ folderID: original.id, snapshot }, host.location)
          .pipe(Effect.flip),
      ).toMatchObject({ message: "Cannot update session folder" });
      expect(yield* Effect.promise(() => host.files.exists(original.id))).toBe(false);
      expect(
        yield* host.rpc.ensure({ folderID: original.id }, host.location).pipe(Effect.flip),
      ).toMatchObject({ message: "Cannot ensure session folder" });
      const preexisting = Session.ID.create();
      yield* host.rpc.write({ folderID: preexisting, snapshot }, host.location);
      yield* Effect.promise(() =>
        writeFile(join(host.files.path(preexisting), "unrelated.txt"), "Keep me."),
      );
      expect(
        yield* host.rpc
          .create({ ...input, folderID: preexisting }, host.location)
          .pipe(Effect.flip),
      ).toMatchObject({ message: "Cannot create persona session" });
      expect(yield* Effect.promise(() => readdir(host.files.path(preexisting)))).toContain(
        "unrelated.txt",
      );
    }),
  ));

test("genuine create failure removes only the new folder", () =>
  withSessionFolders(
    (host) =>
      Effect.gen(function* () {
        expect(yield* host.remote.createSession("persona1").pipe(Effect.flip)).toEqual(
          new Error("Cannot create persona session"),
        );
        expect(yield* Effect.promise(() => readdir(join(host.directory, "sessions")))).toEqual([]);
      }),
    (ctx) => ({
      ...ctx,
      session: { ...ctx.session, create: () => Effect.fail(new Error("Native create failed")) },
    }),
  ));

test("a create that commits before failing keeps its folder and can be retried safely", () =>
  withSessionFolders(
    (host) =>
      Effect.gen(function* () {
        const id = Session.ID.create();
        const snapshot = renderSnapshot(
          host.remote.personas.get("persona1")!,
          "Creation snapshot.",
        );
        const input = { folderID: id, snapshot, model: "test/probe" };
        expect(yield* host.rpc.create(input, host.location).pipe(Effect.flip)).toMatchObject({
          message: "Cannot create persona session",
        });
        expect((yield* host.remote.sessions.get(id)).location.directory).toBe(host.files.path(id));
        expect(yield* host.rpc.read({ folderID: id }, host.location)).toEqual(
          Schema.decodeUnknownSync(folderSnapshot)(snapshot),
        );
        expect(yield* host.rpc.create(input, host.location)).toBe(host.files.path(id));
      }),
    (ctx) => ({
      ...ctx,
      session: {
        ...ctx.session,
        create: (input: Parameters<typeof ctx.session.create>[0]) =>
          ctx.session
            .create(input)
            .pipe(Effect.andThen(Effect.fail(new Error("Response lost after commit")))),
      },
    }),
  ));

test("native new sessions and forks get independent snapshots before prompt execution", () =>
  withSessionFolders((host) =>
    Effect.gen(function* () {
      const { session: original, snapshot } = yield* folderSession(host);
      const fresh = yield* host.remote.client.session.create({
        agent: Agent.ID.make("persona1"),
        model: Model.Ref.parse("test/probe"),
        location: original.location,
      });
      yield* host.remote.sessions.prompt({ sessionID: fresh.id, text: "Immediate native prompt" });
      yield* host.remote.sessions.wait(fresh.id);
      expect((yield* host.remote.sessions.get(fresh.id)).location.directory).toBe(
        host.files.path(fresh.id),
      );
      expect(yield* host.rpc.read({ folderID: fresh.id }, host.location)).toEqual(snapshot);
      const fork = yield* host.remote.client.session.fork({ sessionID: fresh.id });
      yield* host.remote.sessions.prompt({ sessionID: fork.id, text: "Immediate fork prompt" });
      yield* host.remote.sessions.wait(fork.id);
      expect((yield* host.remote.sessions.get(fork.id)).location.directory).toBe(
        host.files.path(fork.id),
      );
      expect(yield* host.rpc.read({ folderID: fork.id }, host.location)).toEqual(snapshot);
      expect(JSON.stringify(yield* host.llm.requests())).toContain("You are Persona1.");
      yield* host.remote.sessions.remove(original.id);
      expect(yield* host.rpc.read({ folderID: fresh.id }, host.location)).toEqual(snapshot);
      const elsewhere = join(host.directory, "ordinary-project");
      yield* Effect.promise(() => mkdir(elsewhere));
      const unrelated = yield* host.remote.client.session.create({
        location: { directory: AbsolutePath.make(elsewhere) },
      });
      expect(
        yield* host.rpc.ensure({ folderID: unrelated.id }, host.location).pipe(Effect.flip),
      ).toMatchObject({ message: "Cannot ensure session folder" });
      expect(yield* Effect.promise(() => host.files.exists(unrelated.id))).toBe(false);
    }),
  ));

test("native relocation resumes prepared folders, selects the persona default, and rejects conflicting bindings", () =>
  withSessionFolders((host) =>
    Effect.gen(function* () {
      const { session: original, snapshot } = yield* folderSession(host);
      const prepared = Session.ID.create();
      yield* host.rpc.write({ folderID: prepared, snapshot }, host.location);
      yield* host.remote.client.session.create({
        id: prepared,
        model: Model.Ref.parse("test/probe"),
        location: original.location,
      });
      expect(yield* host.rpc.ensure({ folderID: prepared }, host.location)).toBe(
        host.files.path(prepared),
      );
      expect((yield* host.remote.sessions.get(prepared)).agent).toBe("persona1");
      const conflict = Session.ID.create();
      yield* host.rpc.write(
        {
          folderID: conflict,
          snapshot: renderSnapshot({ ...snapshot.persona, id: "other" }, "Other rules."),
        },
        host.location,
      );
      yield* host.remote.client.session.create({
        id: conflict,
        agent: Agent.ID.make("persona1"),
        location: original.location,
      });
      expect(
        JSON.stringify(
          yield* host.rpc.ensure({ folderID: conflict }, host.location).pipe(Effect.flip),
        ),
      ).toContain("another persona");
      const wrongAgent = yield* host.remote.client.session.create({
        agent: Agent.ID.make("build"),
        location: original.location,
      });
      expect(
        JSON.stringify(
          yield* host.rpc.ensure({ folderID: wrongAgent.id }, host.location).pipe(Effect.flip),
        ),
      ).toContain("source folder");
      expect(
        JSON.stringify(
          yield* host.rpc
            .update({ folderID: wrongAgent.id, snapshot }, host.location)
            .pipe(Effect.flip),
        ),
      ).toContain("binding does not match");
    }),
  ));

test("native lookup failures are not mistaken for missing sessions or permission to remove folders", () =>
  withSessionFolders(
    (host) =>
      Effect.gen(function* () {
        expect(
          JSON.stringify(
            yield* host.rpc.ensure({ folderID: "ses_io_error" }, host.location).pipe(Effect.flip),
          ),
        ).toContain("Native database unavailable");
        expect(
          JSON.stringify(
            yield* host.rpc.remove({ folderID: "ses_io_error" }, host.location).pipe(Effect.flip),
          ),
        ).toContain("Native database unavailable");
        const vanished = yield* host.remote.client.session.create({
          id: Session.ID.make("ses_deleted_event"),
          location: { directory: AbsolutePath.make(host.directory) },
        });
        yield* host.remote.sessions.remove(vanished.id);
      }),
    (ctx) => ({
      ...ctx,
      session: {
        ...ctx.session,
        get: (input: Parameters<typeof ctx.session.get>[0]) => {
          if (input.sessionID === "ses_io_error")
            return Effect.fail(new Error("Native database unavailable"));
          if (input.sessionID === "ses_deleted_event")
            return Effect.fail(
              Object.assign(new Error("Deleted before the event"), {
                _tag: "Session.NotFoundError",
              }),
            );
          return ctx.session.get(input);
        },
      },
    }),
  ));
