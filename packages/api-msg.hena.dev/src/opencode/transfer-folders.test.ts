import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { sessionDirectory } from "@ren-ai/plugin-session-folder/paths";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";
import { exportSessions, restoreSessions } from "./transfer.ts";
import { sessionArchive } from "./transfer-format.ts";

test("restore uses archived persona, agent and ground rules even after the catalog changes", () =>
  withRemoteHost((remote, root, { llm }) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      yield* remote.sessions.prompt({ sessionID: session.id, text: "His name is Minjun." });
      yield* remote.sessions.wait(session.id);
      yield* remote.sessions.rename({ sessionID: session.id, title: "persona1 · reset yesterday" });
      yield* remote.client.rpc(sessionFolders).write(
        {
          folderID: session.id,
          snapshot: renderSnapshot(
            { ...remote.personas.get("persona1")!, prompt: "You are the archived photographer." },
            "Remember the archived blue umbrella.",
          ),
        },
        { location: { directory: root } },
      );
      const contents = yield* exportSessions(remote.client, [session.id]);
      const saved = Schema.decodeUnknownSync(sessionArchive)(contents).sessions[0]!;
      const updated = new Map([
        [
          "persona1",
          { ...remote.personas.get("persona1")!, prompt: "You are the current pianist." },
        ],
      ]);
      yield* remote.sessions.remove(session.id);
      yield* restoreSessions(remote.client, contents, root, updated);
      expect(
        yield* remote.client
          .rpc(sessionFolders)
          .read({ folderID: session.id }, { location: { directory: root } }),
      ).toEqual(saved.folder);
      const restored = yield* remote.client.session.export({
        sessionID: session.id,
        sanitize: false,
      });
      expect(restored.info).toMatchObject({
        id: session.id,
        agent: "persona1",
        title: "persona1 · reset yesterday",
        location: { directory: sessionDirectory(root, session.id) },
      });
      expect(restored.messages).toEqual(saved.messages);
      // This folder reuses a native location cache; explicitly reload both native
      // instruction sources before verifying model context rather than racing watchers.
      yield* remote.client.location.reload();
      yield* Effect.promise(async () => {
        await expect
          .poll(
            async () =>
              (
                await Effect.runPromise(
                  remote.client.agent.list({ location: restored.info.location }),
                )
              ).data.find((agent) => agent.id === "persona1")?.system,
          )
          .toBe("You are the archived photographer.");
      });
      yield* remote.sessions.prompt({ sessionID: session.id, text: "Do you remember?" });
      yield* remote.sessions.wait(session.id);
      const requests = JSON.stringify(yield* llm.requests());
      expect(requests).toContain("archived photographer");
      expect(requests).toContain("archived blue umbrella");
      expect(requests).not.toContain("current pianist");
    }),
  ));

test("legacy archives require a supplied catalog and render folders before importing paused work", () =>
  withRemoteHost((remote, root, { transport }) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      yield* remote.sessions.prompt({
        sessionID: session.id,
        text: "queued legacy input",
        resume: false,
      });
      const saved = Schema.decodeUnknownSync(sessionArchive)(
        yield* exportSessions(remote.client, [session.id]),
      );
      const contents = Schema.encodeSync(sessionArchive)({
        ...saved,
        sessions: saved.sessions.map(({ folder: _folder, ...entry }) => entry),
      });
      yield* remote.sessions.remove(session.id);
      for (const personas of [undefined, new Map()]) {
        transport.requests.length = 0;
        expect(
          (yield* restoreSessions(remote.client, contents, root, personas).pipe(Effect.flip))
            .message,
        ).toContain("original persona catalog");
        expect(transport.requests).toEqual([]);
      }
      transport.requests.length = 0;
      yield* restoreSessions(remote.client, contents, root, remote.personas);
      const writes = transport.requests.filter((request) => request.method === "POST");
      expect(new URL(writes[0]!.url).pathname).toContain("rpc");
      expect(new URL(writes[1]!.url).pathname).toContain("import");
      const folder = yield* remote.client
        .rpc(sessionFolders)
        .read({ folderID: session.id }, { location: { directory: root } });
      expect(folder.persona).toMatchObject({ id: "persona1", prompt: "You are Persona1.\n" });
      expect(folder.rules).toContain("<conversation-started>");
      expect((yield* remote.sessions.inbox(session.id)).map((item) => item.id)).toEqual(
        saved.sessions[0]!.pending.map((item) => item.id),
      );
      expect((yield* remote.sessions.get(session.id)).location.directory).toBe(
        sessionDirectory(root, session.id),
      );
    }),
  ));

test("unreadable folder snapshots fail export instead of silently producing legacy archives", () =>
  withRemoteHost((remote) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      yield* Effect.promise(() => rm(join(session.location.directory, "AGENTS.md")));
      expect(
        (yield* exportSessions(remote.client, [session.id]).pipe(Effect.flip)).message,
      ).toContain("Cannot read session folder");
    }),
  ));

test("failed folder creation does not import its session", () =>
  withRemoteHost((remote, root) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      const contents = yield* exportSessions(remote.client, [session.id]);
      yield* remote.sessions.remove(session.id);
      yield* Effect.promise(() =>
        mkdir(join(sessionDirectory(root, session.id), "persona.json"), { recursive: true }),
      );
      expect(
        (yield* restoreSessions(remote.client, contents, root).pipe(Effect.flip)).message,
      ).toContain("Cannot write session folder");
      expect(
        yield* remote.client.session
          .get({ sessionID: session.id })
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed("absent"))),
      ).toBe("absent");
    }),
  ));
