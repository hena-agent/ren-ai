import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AbsolutePath, Session } from "@opencode/schema";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { sessionDirectory } from "@ren-ai/plugin-session-folder/paths";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";
import { sessionArchive } from "../opencode/transfer-format.ts";
import { exportSessions, restoreSessions } from "../opencode/transfer.ts";
import { exportLocation } from "./session-transfer.ts";
import { restoreMemory } from "../../test/memory.test-helper.ts";

test("native-created sessions and forks are archived with isolated copies of their inherited scopes", () =>
  withRemoteHost((remote, root) =>
    Effect.gen(function* () {
      const parent = yield* remote.createSession("persona1");
      yield* remote.sessions.prompt({ sessionID: parent.id, text: "Preserve our earlier Memory." });
      yield* remote.sessions.wait(parent.id);
      const initial = yield* remote.client
        .rpc(sessionFolders)
        .read({ folderID: parent.id }, { location: { directory: root } });
      yield* remote.client.rpc(sessionFolders).update(
        {
          folderID: parent.id,
          snapshot: { ...initial, rules: "Historical inherited ground rules." },
        },
        { location: { directory: root } },
      );
      yield* Effect.promise(() =>
        restoreMemory(parent.location.directory, {
          additional: {},
          shortTerm: "Life before the child and fork",
          longTerm: [],
          receipts: {},
        }),
      );
      yield* Effect.promise(() =>
        restoreMemory(
          join(parent.location.directory, "conversations", initial.binding!.conversationKey),
          {
            state: { affection: 83 },
            additional: {},
            shortTerm: "Only this relationship remembers Hana",
            longTerm: [],
            receipts: {},
          },
        ),
      );
      const child = yield* remote.client.session.create({
        agent: parent.agent,
        title: "retained native session",
        location: parent.location,
      });
      const fork = yield* remote.client.session.fork({ sessionID: parent.id });
      for (const session of [child, fork])
        yield* Effect.promise(async () => {
          await expect
            .poll(
              async () =>
                (await Effect.runPromise(remote.sessions.get(session.id))).location.directory,
              { timeout: 5_000 },
            )
            .toBe(sessionDirectory(root, session.id));
        });
      const saved = Schema.decodeUnknownSync(sessionArchive)(
        yield* exportLocation(remote.client, root),
      );
      expect(saved.version).toBe(2);
      expect(saved.personas).toHaveLength(3);
      expect(saved.sessions.map((entry) => entry.info.id).toSorted()).toEqual(
        [parent.id, child.id, fork.id].toSorted(),
      );
      for (const id of [child.id, fork.id]) {
        const scopes = saved.personas.find((entry) => entry.sandboxID === id)!;
        expect(Object.keys(scopes.bindings)).toEqual([id]);
        expect(scopes.snapshot.rules).toBe("Historical inherited ground rules.");
        expect(scopes.snapshot.runtime?.shortTerm).toBe("Life before the child and fork");
        expect(scopes.relationships[id]?.shortTerm).toBe(
          id === fork.id ? "Only this relationship remembers Hana" : "",
        );
      }
      expect(
        saved.personas.find((entry) => entry.sandboxID === fork.id)!.relationships[fork.id]?.state,
      ).toEqual({ affection: 83 });
      const childSnapshot = yield* remote.client
        .rpc(sessionFolders)
        .read({ folderID: child.id }, { location: { directory: root } });
      yield* Effect.promise(() =>
        restoreMemory(parent.location.directory, {
          additional: {},
          shortTerm: "Later shared life",
          longTerm: [],
          receipts: {},
        }),
      );
      const archivedChild = saved.sessions.find((entry) => entry.info.id === child.id)!;
      yield* remote.sessions.remove(child.id);
      yield* restoreSessions(
        remote.client,
        Schema.encodeSync(sessionArchive)({
          ...saved,
          sessions: [archivedChild],
          personas: saved.personas.filter((entry) => entry.sandboxID === child.id),
        }),
        root,
      );
      expect((yield* remote.sessions.get(child.id)).location.directory).toBe(
        sessionDirectory(root, child.id),
      );
      expect((yield* remote.sessions.get(child.id)).title).toBe("retained native session");
      expect(
        yield* remote.client
          .rpc(sessionFolders)
          .read({ folderID: child.id }, { location: { directory: root } }),
      ).toEqual(childSnapshot);
      expect(
        (yield* remote.client.session.export({ sessionID: child.id, sanitize: false })).messages,
      ).toEqual(archivedChild.messages);
      const archivedFork = saved.sessions.find((entry) => entry.info.id === fork.id)!;
      expect(
        (yield* restoreSessions(
          remote.client,
          Schema.encodeSync(sessionArchive)({ ...saved, sessions: [archivedFork] }),
          root,
        ).pipe(Effect.flip)).message,
      ).toContain("full OpenCode volume restore");
      expect(
        (yield* remote.client
          .rpc(sessionFolders)
          .read({ folderID: parent.id }, { location: { directory: root } })).runtime?.shortTerm,
      ).toBe("Later shared life");
    }),
  ));

test("full export rejects unsafe roots and subset export excludes arbitrary managed-folder descendants", () =>
  withRemoteHost((remote, root) =>
    Effect.gen(function* () {
      const parent = yield* remote.createSession("persona1");
      const excluded: Array<Session.ID> = [];
      for (const directory of [
        join(parent.location.directory, "nested", Session.ID.create()),
        join(root, "sandboxes", "not-a-session-id"),
        join(root, "sandboxes", `ses_${"a".repeat(100)}`),
        join(root, "sandboxes", "ses_bad name"),
        join(root, "personas", "bad name"),
        join(root, "unrelated"),
      ]) {
        yield* Effect.promise(() => mkdir(directory, { recursive: true }));
        const session = yield* remote.client.session.create({
          location: { directory: AbsolutePath.make(directory) },
        });
        excluded.push(session.id);
      }
      expect((yield* exportLocation(remote.client, root).pipe(Effect.flip)).message).toBe(
        "Cannot inventory persona scopes",
      );
      const saved = Schema.decodeUnknownSync(sessionArchive)(
        yield* exportSessions(remote.client, [parent.id]),
      );
      expect(saved.sessions.map((entry) => entry.info.id)).toEqual([parent.id]);
      expect((yield* exportSessions(remote.client, excluded).pipe(Effect.flip)).message).toBe(
        "Migrate legacy sessions before exporting shared life",
      );
    }),
  ));
