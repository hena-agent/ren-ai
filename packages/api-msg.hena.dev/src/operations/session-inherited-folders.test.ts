import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AbsolutePath, Session } from "@opencode/schema";
import { SessionMessage } from "@opencode/schema/session-message";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { sessionDirectory } from "@ren-ai/plugin-session-folder/paths";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";
import { sessionArchive } from "../opencode/transfer-format.ts";
import { exportSessions, restoreSessions } from "../opencode/transfer.ts";
import { exportLocation } from "./session-transfer.ts";

test("native-created and forked sessions in an inherited managed folder are archived with their source snapshot", () =>
  withRemoteHost((remote, root, { transport }) =>
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
      const original = yield* remote.client
        .rpc(sessionFolders)
        .read({ folderID: parent.id }, { location: { directory: root } });
      const child = yield* remote.client.session.create({
        agent: parent.agent,
        title: "retained native session",
        location: parent.location,
      });
      const fork = yield* remote.client.session.fork({ sessionID: parent.id });
      expect(child.location.directory).toBe(parent.location.directory);
      expect(fork.location.directory).toBe(parent.location.directory);

      // Replay native source-state responses at the API seam so a later lifecycle
      // move cannot hide the inherited-folder export regression.
      const inherited = new Map([
        [child.id, child],
        [fork.id, fork],
      ]);
      const exports = new Map<Session.ID, string>();
      for (const session of inherited.values()) {
        const data = yield* remote.client.session.export({
          sessionID: session.id,
          sanitize: false,
        });
        exports.set(
          session.id,
          Schema.encodeSync(
            Schema.fromJsonString(
              Schema.Struct({
                info: Session.Info,
                messages: Schema.Array(SessionMessage.Info),
              }),
            ),
          )({ info: session, messages: data.messages }),
        );
      }
      const inventory = yield* remote.client.session.list({ limit: 100 });
      const forward = transport.fetch;
      transport.fetch = (request) => {
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path === "/api/session")
          return Promise.resolve(
            Response.json({
              cursor: {},
              data: Schema.encodeSync(Schema.Array(Session.Info))(
                inventory.data.map((session) => inherited.get(session.id) ?? session),
              ),
            }),
          );
        for (const [id, contents] of exports)
          if (path === `/api/session/${id}/export`)
            return Promise.resolve(
              new Response(contents, { headers: { "content-type": "application/json" } }),
            );
        return forward(request);
      };
      const saved = Schema.decodeUnknownSync(sessionArchive)(
        yield* exportLocation(remote.client, root),
      );
      transport.fetch = forward;
      expect(saved.sessions.map((entry) => entry.info.id).toSorted()).toEqual(
        [parent.id, child.id, fork.id].toSorted(),
      );
      for (const id of [child.id, fork.id])
        expect(saved.sessions.find((entry) => entry.info.id === id)?.folder).toEqual(original);
      const archivedChild = saved.sessions.find((entry) => entry.info.id === child.id)!;
      yield* remote.sessions.remove(child.id);
      yield* restoreSessions(
        remote.client,
        Schema.encodeSync(sessionArchive)({ version: 1, sessions: [archivedChild] }),
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
      ).toEqual(original);
      expect(
        (yield* remote.client.session.export({ sessionID: child.id, sanitize: false })).messages,
      ).toEqual(archivedChild.messages);
      const archivedFork = saved.sessions.find((entry) => entry.info.id === fork.id)!;
      expect(
        (yield* restoreSessions(
          remote.client,
          Schema.encodeSync(sessionArchive)({ version: 1, sessions: [archivedFork] }),
          root,
        ).pipe(Effect.flip)).message,
      ).toContain("full OpenCode volume restore");
      expect(
        yield* remote.client
          .rpc(sessionFolders)
          .read({ folderID: parent.id }, { location: { directory: root } }),
      ).toEqual(original);
    }),
  ));

test("scoped export excludes unsafe direct folder names and arbitrary managed-folder descendants", () =>
  withRemoteHost((remote, root) =>
    Effect.gen(function* () {
      const parent = yield* remote.createSession("persona1");
      const excluded: Array<Session.ID> = [];
      for (const directory of [
        join(parent.location.directory, "nested", Session.ID.create()),
        join(root, "sessions", "not-a-session-id"),
        join(root, "sessions", `ses_${"a".repeat(100)}`),
        join(root, "sessions", "ses_bad name"),
        join(root, "unrelated"),
      ]) {
        yield* Effect.promise(() => mkdir(directory, { recursive: true }));
        const session = yield* remote.client.session.create({
          location: { directory: AbsolutePath.make(directory) },
        });
        excluded.push(session.id);
      }
      const saved = Schema.decodeUnknownSync(sessionArchive)(
        yield* exportLocation(remote.client, root),
      );
      expect(saved.sessions.map((entry) => entry.info.id)).toEqual([parent.id]);
      const explicit = Schema.decodeUnknownSync(sessionArchive)(
        yield* exportSessions(remote.client, excluded),
      );
      expect(explicit.sessions.every((entry) => !entry.folder)).toBe(true);
    }),
  ));
