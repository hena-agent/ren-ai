import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { withSessionFolders } from "../../test/session-folder.test-helper.ts";
import { Agent, Model } from "@opencode/schema";
import { readSessionBinding } from "@ren-ai/plugin-session-folder/bindings";
import { restoreMemory } from "../../test/memory.test-helper.ts";
import { exportSessions, restoreSessions } from "./transfer.ts";
import { sessionArchive } from "./transfer-format.ts";

test("an interrupted native Sandbox move resumes its durable copy instead of cloning again", () => {
  let unavailable = true;
  return withSessionFolders(
    (host) =>
      Effect.gen(function* () {
        const parent = yield* host.remote.createSession("persona1");
        yield* Effect.promise(() =>
          restoreMemory(parent.location.directory, {
            additional: {},
            shortTerm: "Original life",
            longTerm: [],
            receipts: {},
          }),
        );
        const child = yield* host.remote.client.session.create({
          agent: Agent.ID.make("persona1"),
          model: Model.Ref.parse("test/probe"),
          location: parent.location,
        });
        expect(
          yield* host.rpc.ensure({ folderID: child.id }, host.location).pipe(Effect.flip),
        ).toMatchObject({ message: "Cannot ensure session folder" });
        expect(
          (yield* host.rpc.read({ folderID: child.id }, host.location)).runtime?.shortTerm,
        ).toBe("Original life");
        yield* Effect.promise(() =>
          restoreMemory(parent.location.directory, {
            additional: {},
            shortTerm: "Newer production life",
            longTerm: [],
            receipts: {},
          }),
        );
        unavailable = false;
        yield* host.remote.client.session.switchAgent({
          sessionID: child.id,
          agent: Agent.ID.make("build"),
        });
        expect(
          JSON.stringify(
            yield* host.rpc.ensure({ folderID: child.id }, host.location).pipe(Effect.flip),
          ),
        ).toContain("Pending Sandbox persona binding does not match");
        expect((yield* host.remote.sessions.get(child.id)).location.directory).toBe(
          parent.location.directory,
        );
        yield* host.remote.client.session.switchAgent({
          sessionID: child.id,
          agent: Agent.ID.make("persona1"),
        });
        expect(yield* host.rpc.ensure({ folderID: child.id }, host.location)).toBe(
          join(host.directory, "sandboxes", child.id),
        );
        expect(
          (yield* host.rpc.read({ folderID: child.id }, host.location)).runtime?.shortTerm,
        ).toBe("Original life");
        expect((yield* host.remote.sessions.get(parent.id)).location.directory).toBe(
          parent.location.directory,
        );
      }),
    (ctx) => ({
      ...ctx,
      session: {
        ...ctx.session,
        move: (input: Parameters<typeof ctx.session.move>[0]) =>
          unavailable ? Effect.fail(new Error("Interrupted native move")) : ctx.session.move(input),
      },
    }),
  );
});

test("managed sessions share their persona folder and deleting one preserves its sibling and scopes", () =>
  withSessionFolders((host) =>
    Effect.gen(function* () {
      const first = yield* host.remote.createSession("persona1");
      const second = yield* host.remote.createSession("persona1");
      expect(first.location.directory).toBe(join(host.directory, "personas", "persona1"));
      expect(second.location.directory).toBe(first.location.directory);
      yield* host.remote.sessions.remove(first.id);
      expect((yield* host.remote.sessions.get(second.id)).location.directory).toBe(
        first.location.directory,
      );
      expect(
        yield* Effect.promise(() =>
          readFile(join(first.location.directory, "persona.json"), "utf8"),
        ),
      ).toContain("persona1");
      expect((yield* host.rpc.read({ folderID: second.id }, host.location)).persona.id).toBe(
        "persona1",
      );
    }),
  ));

test("one coherent persona snapshot restores both bindings and rejects stale restores over live documents", () =>
  withSessionFolders((host) =>
    Effect.gen(function* () {
      const first = yield* host.remote.createSession("persona1", undefined, "first");
      const second = yield* host.remote.createSession("persona1", undefined, "second");
      const contents = yield* exportSessions(host.remote.client, [first.id, second.id]);
      const archive = Schema.decodeUnknownSync(sessionArchive)(contents);
      expect(archive.personas).toHaveLength(1);
      expect(Object.keys(archive.personas[0]!.bindings)).toHaveLength(2);
      yield* host.remote.sessions.remove(first.id);
      yield* host.remote.sessions.remove(second.id);
      yield* restoreSessions(host.remote.client, contents, host.directory);
      const restored = yield* host.rpc.read({ folderID: second.id }, host.location);
      expect(restored.binding?.conversationKey).toBe("second");
      expect((yield* host.remote.sessions.get(first.id)).location.directory).toBe(
        first.location.directory,
      );
      yield* Effect.promise(() =>
        restoreMemory(first.location.directory, {
          additional: {},
          shortTerm: "Newer live life",
          longTerm: [],
          receipts: {},
        }),
      );
      expect(
        yield* host.rpc
          .restore({ snapshot: archive.personas[0]! }, host.location)
          .pipe(Effect.flip),
      ).toMatchObject({ message: "Cannot restore persona folder" });
      expect(
        (yield* host.rpc.read({ folderID: second.id }, host.location)).runtime?.shortTerm,
      ).toBe("Newer live life");
    }),
  ));

test("new native sessions and forks run isolated copied scopes and never join production writers", () =>
  withSessionFolders((host) =>
    Effect.gen(function* () {
      const original = yield* host.remote.createSession("persona1", undefined, "relationship-one");
      const root = original.location.directory;
      yield* Effect.promise(() =>
        restoreMemory(root, {
          additional: {},
          shortTerm: "Life before sandbox",
          longTerm: [],
          receipts: {},
        }),
      );
      yield* Effect.promise(() =>
        restoreMemory(join(root, "conversations", "relationship-one"), {
          state: { affection: 83 },
          additional: {},
          shortTerm: "Only this relationship knows Hana",
          longTerm: [],
          receipts: {},
        }),
      );
      const fresh = yield* host.remote.client.session.create({
        agent: Agent.ID.make("persona1"),
        model: Model.Ref.parse("test/probe"),
        location: original.location,
      });
      const freshPath = yield* host.rpc.ensure({ folderID: fresh.id }, host.location);
      expect(freshPath).toBe(join(host.directory, "sandboxes", fresh.id));
      expect(
        (yield* host.rpc.read({ folderID: fresh.id }, host.location)).relationship?.shortTerm,
      ).toBe("");
      yield* host.remote.sessions.prompt({ sessionID: original.id, text: "Hello" });
      yield* host.remote.sessions.wait(original.id);
      const fork = yield* host.remote.client.session.fork({ sessionID: original.id });
      const forkPath = yield* host.rpc.ensure({ folderID: fork.id }, host.location);
      const copied = yield* host.rpc.read({ folderID: fork.id }, host.location);
      expect(copied.runtime?.shortTerm).toBe("Life before sandbox");
      expect(copied.relationship?.shortTerm).toBe("Only this relationship knows Hana");
      expect(forkPath).toBe(join(host.directory, "sandboxes", fork.id));
      yield* Effect.promise(() =>
        restoreMemory(forkPath, {
          additional: {},
          shortTerm: "Sandbox changes",
          longTerm: [],
          receipts: {},
        }),
      );
      expect(
        (yield* host.rpc.read({ folderID: original.id }, host.location)).runtime?.shortTerm,
      ).toBe("Life before sandbox");
      yield* host.remote.sessions.writable(original.id, false);
      expect(yield* Effect.promise(() => readSessionBinding(root, original.id))).toMatchObject({
        conversationKey: "relationship-one",
        writable: false,
      });
    }),
  ));
