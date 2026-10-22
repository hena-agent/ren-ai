import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { personaDirectory, sessionDirectory } from "@ren-ai/plugin-session-folder/paths";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";
import { exportSessions, restoreSessions } from "./transfer.ts";
import { sessionArchive } from "./transfer-format.ts";

test("restore uses archived persona, agent and ground rules", () =>
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
      yield* remote.sessions.remove(session.id);
      yield* restoreSessions(remote.client, contents, root);
      expect(
        yield* remote.client
          .rpc(sessionFolders)
          .read({ folderID: session.id }, { location: { directory: root } }),
      ).toMatchObject(saved.folder);
      const restored = yield* remote.client.session.export({
        sessionID: session.id,
        sanitize: false,
      });
      expect(restored.info).toMatchObject({
        id: session.id,
        agent: "persona1",
        title: "persona1 · reset yesterday",
        location: { directory: personaDirectory(root, "persona1") },
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
            { timeout: 5_000 },
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

test("ordinary restore rejects legacy unsplit memory and current archives missing persona scopes before mutations", () =>
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
      yield* remote.sessions.remove(session.id);
      for (const archive of [
        { ...saved, version: 1 },
        { ...saved, version: "PRIVATE_ARCHIVE_PAYLOAD" },
        { version: 2, sessions: saved.sessions },
        { ...saved, personas: [] },
      ]) {
        transport.requests.length = 0;
        const rejected = yield* restoreSessions(
          remote.client,
          JSON.stringify({ ...archive, privateMarker: "PRIVATE_ARCHIVE_PAYLOAD" }),
          root,
        ).pipe(Effect.flip);
        expect(rejected).toBeInstanceOf(Error);
        expect(rejected.message).not.toContain("PRIVATE_ARCHIVE_PAYLOAD");
        expect(transport.requests).toEqual([]);
      }
    }),
  ));

test("unreadable folder snapshots fail export instead of silently producing legacy archives", () =>
  withRemoteHost((remote) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      yield* Effect.promise(() => rm(join(session.location.directory, "AGENTS.md")));
      expect(
        (yield* exportSessions(remote.client, [session.id]).pipe(Effect.flip)).message,
      ).toContain("Cannot snapshot persona folder");
    }),
  ));

test("export rejects a native location that differs from its durable scope", () =>
  withRemoteHost((remote, root, { transport }) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      const forward = transport.fetch;
      transport.fetch = async (request) => {
        const response = await forward(request);
        if (!new URL(request.url).pathname.endsWith(`/${session.id}/export`)) return response;
        return new Response(
          (await response.text()).replace(
            JSON.stringify(session.location.directory),
            JSON.stringify(sessionDirectory(root, session.id)),
          ),
          { headers: response.headers },
        );
      };
      expect(
        (yield* exportSessions(remote.client, [session.id]).pipe(Effect.flip)).message,
      ).toContain("Session location does not match its durable persona scope");
    }),
  ));

test("failed folder creation does not import its session", () =>
  withRemoteHost((remote, root) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      const contents = yield* exportSessions(remote.client, [session.id]);
      yield* remote.sessions.remove(session.id);
      yield* Effect.promise(async () => {
        await rm(personaDirectory(root, "persona1"), { recursive: true });
        await mkdir(join(personaDirectory(root, "persona1"), "persona.json"), { recursive: true });
      });
      expect(
        (yield* restoreSessions(remote.client, contents, root).pipe(Effect.flip)).message,
      ).toContain("Cannot restore persona folder");
      expect(
        yield* remote.client.session
          .get({ sessionID: session.id })
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed("absent"))),
      ).toBe("absent");
    }),
  ));
