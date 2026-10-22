import { mkdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Session } from "@opencode/schema";
import { createEmbeddedRoutes } from "@opencode/server/routes";
import { Effect, Result, Schema } from "effect";
import { expect, test } from "vitest";
import { folderFiles, renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import {
  managedTransferSession,
  withTransferClient,
} from "../../test/operations-transfer.test-helper.ts";
import { sessionArchive } from "../opencode/transfer-format.ts";
import { exportSessions, restoreSessions } from "../opencode/transfer.ts";
import { exportOffline } from "./offline-export.ts";
import { exportLocation, runSessionTransfer } from "./session-transfer.ts";

const runtime = (text: string) => ({
  state: { mood: 73 },
  additional: {},
  shortTerm: text,
  longTerm: [
    {
      id: "lasting",
      topic: "A lasting memory",
      text,
      summary: text,
      clarity: "clear" as const,
      reason: "Preserve this experience",
      source: "original",
      createdAt: "2026-10-22",
      updatedAt: "2026-10-22",
    },
  ],
  receipts: { "original:call": { operation: "update_memory", inputHash: "hash", output: "saved" } },
  observations: { original: { memory: "revision" } },
});

const offline = (root: string) =>
  exportOffline(
    createEmbeddedRoutes({
      database: { path: ":memory:" },
      config: { directory: join(root, "offline-config"), project: false },
      models: { fetch: false },
    }),
    root,
  );

test.each(["online", "offline"] as const)(
  "%s export preserves every sessionless root and its private execution data",
  async (mode) => {
    const exported = await withTransferClient(({ client, root, personas, calls }) =>
      Effect.gen(function* () {
        const snapshot = {
          ...renderSnapshot(personas.get("persona1")!, "Private ground rules"),
          runtime: runtime("My continuing life"),
          relationship: { ...runtime("Private promise"), state: { affection: 81 } },
        };
        const ids = [Session.ID.create(), Session.ID.create()];
        for (const [index, folderID] of ids.entries()) {
          yield* client
            .rpc(sessionFolders)
            .create(
              { folderID, snapshot, model: "test/probe", conversationKey: `relation-${index}` },
              { location: { directory: root } },
            );
        }
        for (const sessionID of ids) {
          yield* client.session.remove({ sessionID });
          yield* client
            .rpc(sessionFolders)
            .remove({ folderID: sessionID }, { location: { directory: root } });
        }
        yield* Effect.promise(async () => {
          const files = folderFiles(root);
          await files.restore({
            snapshot: {
              ...snapshot,
              persona: { ...snapshot.persona, id: "persona2" },
            },
            bindings: {},
            relationships: {},
          });
          await files.restore({
            snapshot,
            sandboxID: "ses_standalone",
            bindings: {},
            relationships: {},
          });
          await mkdir(join(root, "personas", ".unfinished.initial"));
          await mkdir(join(root, "sandboxes", ".unfinished.tmp"));
          // Inventory must recover the root WAL before reading either scope.
          await writeFile(
            join(root, "personas", "persona1", ".memory", "pending.json"),
            JSON.stringify([
              { name: "MEMORY.md", text: "Recovered continuing life" },
              { name: "conversations/relation-0/MEMORY.md", text: "Recovered private promise" },
            ]),
          );
        });
        calls.length = 0;
        const contents = yield* mode === "online" ? exportLocation(client, root) : offline(root);
        const archive = Schema.decodeUnknownSync(sessionArchive)(contents);
        expect(archive.sessions).toEqual([]);
        expect(archive.personas).toHaveLength(3);
        const life = archive.personas.find(
          (entry) => !entry.sandboxID && entry.snapshot.persona.id === "persona1",
        )!;
        expect(life.bindings).toEqual({});
        expect(life.snapshot.runtime).toEqual({
          ...snapshot.runtime,
          shortTerm: "Recovered continuing life",
        });
        expect(life.relationships).toEqual({
          "relation-0": { ...snapshot.relationship, shortTerm: "Recovered private promise" },
          "relation-1": snapshot.relationship,
        });
        expect(
          archive.personas.filter((entry) => entry.sandboxID === "ses_standalone"),
        ).toHaveLength(1);
        expect(
          archive.personas.find((entry) => entry.snapshot.persona.id === "persona2")?.relationships,
        ).toEqual({});
        if (mode === "online") {
          expect(calls.filter((call) => call.path.endsWith("/inventory"))).toHaveLength(1);
          expect(calls.filter((call) => call.path.endsWith("/snapshot"))).toEqual([]);
        } else expect(calls).toEqual([]);
        return contents;
      }),
    );
    await withTransferClient(({ client, root, personas }) =>
      Effect.gen(function* () {
        yield* restoreSessions(client, exported, root);
        const id = Session.ID.create();
        yield* client.rpc(sessionFolders).create(
          {
            folderID: id,
            snapshot: renderSnapshot(personas.get("persona1")!, "Current rules"),
            model: "test/probe",
            conversationKey: "new-relationship",
          },
          { location: { directory: root } },
        );
        const restored = yield* client
          .rpc(sessionFolders)
          .snapshot({ folderID: id }, { location: { directory: root } });
        const original = Schema.decodeUnknownSync(sessionArchive)(exported).personas.find(
          (entry) => !entry.sandboxID && entry.snapshot.persona.id === "persona1",
        )!;
        expect(restored.snapshot.runtime).toEqual(original.snapshot.runtime);
        expect(restored.relationships["relation-0"]).toEqual(original.relationships["relation-0"]);
        expect(restored.relationships["relation-1"]).toEqual(original.relationships["relation-1"]);
        expect(restored.relationships["new-relationship"]?.shortTerm).toBe("");
        const visible = yield* client
          .rpc(sessionFolders)
          .read({ folderID: id }, { location: { directory: root } });
        expect(visible.runtime?.shortTerm).toBe("Recovered continuing life");
        expect(visible.relationship?.shortTerm).toBe("");
      }),
    );
  },
);

test("full export captures active metadata from its single inventory snapshot", () =>
  withTransferClient(({ client, root, personas, calls, transport }) =>
    Effect.gen(function* () {
      const original = renderSnapshot(personas.get("persona1")!, "Original rules");
      const ids = [Session.ID.create(), Session.ID.create()];
      for (const folderID of ids)
        yield* client
          .rpc(sessionFolders)
          .create(
            { folderID, snapshot: original, model: "test/probe" },
            { location: { directory: root } },
          );
      const fetch = transport.fetch;
      transport.fetch = async (request) => {
        const response = await fetch(request);
        if (new URL(request.url).pathname.endsWith("/inventory"))
          await folderFiles(root).update(ids[0]!, { ...original, rules: "Later rules" });
        return response;
      };
      calls.length = 0;
      const archive = Schema.decodeUnknownSync(sessionArchive)(yield* exportLocation(client, root));
      expect(archive.personas).toHaveLength(1);
      expect(archive.sessions).toHaveLength(2);
      for (const session of archive.sessions) {
        expect(session.folder.rules).toBe("Original rules");
        expect(session.folder.persona).toEqual(archive.personas[0]!.snapshot.persona);
        expect(session.folder.binding).toEqual(archive.personas[0]!.bindings[session.info.id]);
      }
      expect(archive.personas[0]!.snapshot.rules).toBe("Original rules");
      expect((yield* Effect.promise(() => folderFiles(root).read(ids[0]!))).rules).toBe(
        "Later rules",
      );
      expect(calls.filter((call) => call.path.endsWith("/inventory"))).toHaveLength(1);
      expect(calls.filter((call) => call.path.endsWith("/snapshot"))).toEqual([]);
      expect(
        (yield* exportSessions(client, ids, { root, snapshots: [] }).pipe(Effect.flip)).message,
      ).toContain("Inventory has no session scope");
      expect(
        (yield* exportSessions(client, [], {
          root,
          snapshots: [...archive.personas, ...archive.personas],
        }).pipe(Effect.flip)).message,
      ).toBe("Duplicate persona scope in inventory");
    }),
  ));

test.each([
  "corrupt",
  "symlink",
  "invalid-name",
  "wrong-persona",
  "sandbox-symlink",
  "collection-symlink",
  "binding-name",
  "binding-mismatch",
  "missing-relationship",
] as const)("export rejects a %s sessionless root without writing an archive", (damage) =>
  withTransferClient(({ client, root, personas }) =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        const target = await folderFiles(root).restore({
          snapshot: {
            ...renderSnapshot(personas.get("persona1")!, "Rules"),
            runtime: runtime("Life"),
          },
          bindings: {},
          relationships: {},
        });
        if (damage === "corrupt") await writeFile(join(target, "persona.json"), "invalid");
        if (damage === "symlink") {
          await rm(target, { recursive: true });
          await symlink(join(root, "content"), target);
        }
        if (damage === "invalid-name") await mkdir(join(root, "personas", "bad name"));
        if (["binding-name", "binding-mismatch", "missing-relationship"].includes(damage)) {
          await folderFiles(root).write(
            "ses_retained",
            renderSnapshot(personas.get("persona1")!, "Rules"),
            { conversationKey: "retained" },
          );
          if (damage === "binding-name")
            await rename(
              join(target, ".sessions", "ses_retained.json"),
              join(target, ".sessions", "ses_retained"),
            );
          if (damage === "binding-mismatch")
            await writeFile(
              join(root, "personas", ".bindings", "ses_retained.json"),
              JSON.stringify({
                personaID: "persona1",
                conversationKey: "retained",
                writable: false,
                sandbox: false,
              }),
            );
          if (damage === "missing-relationship")
            await rm(join(target, "conversations", "retained"), { recursive: true });
        }
        if (damage === "sandbox-symlink") {
          await mkdir(join(root, "sandboxes"));
          await symlink(target, join(root, "sandboxes", "ses_link"));
        }
        if (damage === "collection-symlink") {
          await symlink(join(root, "personas"), join(root, "sandboxes"));
        }
        if (damage === "wrong-persona") {
          const persona = renderSnapshot(personas.get("persona1")!, "Rules").persona;
          await writeFile(
            join(target, "persona.json"),
            JSON.stringify({ ...persona, id: "other" }),
          );
          await rename(
            join(target, ".opencode", "agents", "persona1.md"),
            join(target, ".opencode", "agents", "other.md"),
          );
        }
      });
      const file = join(root, "must-not-exist.json");
      const result = yield* runSessionTransfer(client, {
        operation: "export",
        file,
        directory: root,
        confirmation: undefined,
      }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      yield* Effect.promise(async () => {
        await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
      });
      expect(Result.isFailure(yield* offline(root).pipe(Effect.result))).toBe(true);
    }),
  ),
);

test("an empty global root exports an empty archive online and offline", () =>
  withTransferClient(({ client, root }) =>
    Effect.gen(function* () {
      for (const contents of [yield* exportLocation(client, root), yield* offline(root)])
        expect(Schema.decodeUnknownSync(sessionArchive)(contents)).toEqual({
          version: 2,
          personas: [],
          sessions: [],
        });
    }),
  ));

test("active native sessions with a missing local binding cannot export inconsistent scope metadata", () =>
  withTransferClient(({ client, root, personas }) =>
    Effect.gen(function* () {
      const { id, directory } = yield* managedTransferSession({ client, root, personas }, "Rules");
      yield* Effect.promise(() => rm(join(directory, ".sessions", `${id}.json`)));
      expect((yield* exportLocation(client, root).pipe(Effect.flip)).message).toContain(
        "Snapshot has no session binding",
      );
      const failure = yield* client
        .rpc(sessionFolders)
        .snapshot({ folderID: id }, { location: { directory: root } })
        .pipe(Effect.flip);
      expect(JSON.stringify(failure)).toContain("Snapshot has no session binding");
      expect((yield* client.session.get({ sessionID: id })).location.directory).toBe(directory);
      expect(yield* Effect.promise(() => stat(join(directory, "persona.json")))).toBeDefined();
    }),
  ));
