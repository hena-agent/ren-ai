import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { folderSession, withSessionFolders } from "../../test/session-folder.test-helper.ts";
import { sessionDirectory } from "@ren-ai/plugin-session-folder/paths";

const archivedFolderSession = (host: Parameters<typeof folderSession>[0]) =>
  Effect.gen(function* () {
    const { session } = yield* folderSession(host);
    const archive = yield* host.rpc.snapshot({ folderID: session.id }, host.location);
    return { session, archive };
  });

test("an existing Sandbox cannot switch persona and incoming bindings cannot impersonate another persona", () =>
  withSessionFolders((host) =>
    Effect.gen(function* () {
      const { session, snapshot } = yield* folderSession(host);
      const binding = snapshot.binding!;
      const failure = yield* host.rpc
        .write(
          {
            folderID: session.id,
            snapshot: { ...snapshot, binding: { ...binding, personaID: "other" } },
          },
          host.location,
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(failure)).toContain("Snapshot persona binding does not match");
      const sandboxID = "ses_identity";
      yield* Effect.promise(async () => {
        await host.files.write(sandboxID, snapshot, { sandbox: true });
        const before = await host.files.snapshot(sandboxID);
        await expect(
          host.files.write(
            sandboxID,
            { ...before.snapshot, persona: { ...before.snapshot.persona, id: "other" } },
            { sandbox: true },
          ),
        ).rejects.toThrow("A session's persona cannot change");
        expect(await host.files.snapshot(sandboxID)).toEqual(before);
      });
      expect(yield* host.rpc.read({ folderID: session.id }, host.location)).toEqual(snapshot);
    }),
  ));

test("restore refuses divergent retained Relationships and invalid or occupied bindings without changing either scope", () =>
  withSessionFolders((host) =>
    Effect.gen(function* () {
      const { session, archive } = yield* archivedFolderSession(host);
      const binding = archive.bindings[session.id]!;
      const relationship = archive.relationships[binding.conversationKey]!;
      const cases = [
        {
          snapshot: {
            ...archive,
            relationships: {
              [binding.conversationKey]: {
                ...relationship,
                shortTerm: "Conflicting private promise",
              },
            },
          },
          message: "Restore conflicts with existing Relationship scope",
        },
        {
          snapshot: { ...archive, bindings: { [session.id]: { ...binding, personaID: "other" } } },
          message: "Invalid archived session binding",
        },
        {
          snapshot: { ...archive, relationships: {} },
          message: "Invalid archived session binding",
        },
        {
          snapshot: { ...archive, sandboxID: session.id },
          message: "Restore binding already exists",
        },
        {
          snapshot: { ...archive, bindings: { [session.id]: { ...binding, writable: false } } },
          message: "Restore binding already exists",
        },
        {
          snapshot: {
            ...archive,
            relationships: { ...archive.relationships, replacement: relationship },
            bindings: { [session.id]: { ...binding, conversationKey: "replacement" } },
          },
          message: "Restore binding already exists",
        },
      ];
      for (const invalid of cases) {
        const failure = yield* host.rpc
          .restore({ snapshot: invalid.snapshot }, host.location)
          .pipe(Effect.flip);
        expect(JSON.stringify(failure)).toContain(invalid.message);
        expect(yield* host.rpc.snapshot({ folderID: session.id }, host.location)).toEqual(archive);
      }
      yield* Effect.promise(async () => {
        await expect(stat(sessionDirectory(host.directory, session.id))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(
          stat(join(session.location.directory, "conversations", "replacement")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      });
      expect((yield* host.remote.sessions.get(session.id)).location.directory).toBe(
        session.location.directory,
      );
    }),
  ));

test("native RPC write-access and Relationship deletion failures preserve existing data", () =>
  withSessionFolders((host) =>
    Effect.gen(function* () {
      const { session, archive } = yield* archivedFolderSession(host);
      const key = archive.bindings[session.id]!.conversationKey;
      expect(
        yield* host.rpc
          .writable({ folderID: "ses_missing", writable: false }, host.location)
          .pipe(Effect.flip),
      ).toMatchObject({ message: "Cannot change session write access" });
      const relations = join(session.location.directory, "conversations");
      const retained = join(session.location.directory, ".retained-conversations");
      yield* Effect.promise(async () => {
        await rename(relations, retained);
        await writeFile(relations, "Storage path is occupied");
      });
      expect(
        yield* host.rpc
          .removeRelationship({ personaID: "persona1", conversationKey: key }, host.location)
          .pipe(Effect.flip),
      ).toMatchObject({ message: "Cannot remove Relationship scope" });
      yield* Effect.promise(async () => {
        expect(await readFile(relations, "utf8")).toBe("Storage path is occupied");
        await rm(relations);
        await rename(retained, relations);
      });
      expect(yield* host.rpc.snapshot({ folderID: session.id }, host.location)).toEqual(archive);
      // A failed deletion must not have altered the binding's write authority either.
      expect(
        (yield* host.rpc.read({ folderID: session.id }, host.location)).binding?.writable,
      ).toBe(true);
    }),
  ));
