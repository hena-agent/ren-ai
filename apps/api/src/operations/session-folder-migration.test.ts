import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AbsolutePath, Session } from "@opencode/schema";
import { Effect, Schema } from "effect";
import { expect, test, vi } from "vitest";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { personaDirectory } from "@ren-ai/plugin-session-folder/paths";
import { legacySession, withTransferClient } from "../../test/operations-transfer.test-helper.ts";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";
import { runSharedLifeCutover } from "./shared-life-cutover.ts";
import { runSessionTransfer } from "./session-transfer.ts";

type Client = Parameters<typeof runSharedLifeCutover>[0];
type Input = Parameters<typeof runSharedLifeCutover>[1];

const pausedInput = (
  client: Client,
  directory: string,
  personas: Input["personas"],
  sessions: readonly Session.Info[],
) =>
  Effect.gen(function* () {
    const entries = yield* Effect.forEach(sessions, (session) =>
      Effect.gen(function* () {
        const native = yield* client.session.export({ sessionID: session.id, sanitize: false });
        const persona = { ...personas.get("persona1")!, id: session.agent! };
        return {
          info: Schema.encodeSync(Session.Info)(native.info),
          pending: [],
          folder: {
            ...renderSnapshot(persona, "Original pre-upgrade instructions."),
            runtime: {
              additional: {},
              shortTerm: `Private memory for ${session.id}`,
              longTerm: [],
              receipts: {},
            },
          },
        };
      }),
    );
    return {
      directory,
      personas,
      confirmation: "yes",
      log: vi.fn<NonNullable<Input["log"]>>(),
      archive: JSON.stringify({ version: 1, sessions: entries }),
      application: JSON.stringify({
        version: 1,
        tables: [
          {
            name: "conversation",
            columns: ["session_id", "persona_id", "usage_key", "ended_at"],
            rows: sessions.map((session, index) => [
              session.id,
              session.agent,
              session.id,
              index ? 1 : null,
            ]),
          },
        ],
      }),
    };
  });

const singleSource = (client: Client, directory: string, personas: Input["personas"]) =>
  Effect.gen(function* () {
    const session = yield* legacySession(client, directory);
    return { session, input: yield* pausedInput(client, directory, personas, [session]) };
  });

test.each(["catalog", "queued", "location"] as const)(
  "shared-life cutover preflights every source before any writes (%s)",
  (blocked) =>
    withTransferClient(({ client, root, personas, calls }) =>
      Effect.gen(function* () {
        const first = yield* legacySession(client, root);
        const second = yield* legacySession(
          client,
          root,
          blocked === "catalog" ? "missing" : "persona1",
        );
        const input = yield* pausedInput(
          client,
          root,
          personas,
          blocked === "catalog" ? [second, first] : [first, second],
        );
        if (blocked === "queued")
          yield* client.session.prompt({
            sessionID: second.id,
            text: "Queued after the backup",
            resume: false,
          });
        let secondDirectory = root;
        if (blocked === "location") {
          secondDirectory = join(root, "operator-project");
          yield* Effect.promise(() => mkdir(secondDirectory));
          yield* client.session.move({
            sessionID: second.id,
            directory: AbsolutePath.make(secondDirectory),
          });
          yield* client.session.wait({ sessionID: second.id });
        }
        calls.length = 0;
        const error = yield* runSharedLifeCutover(client, input).pipe(Effect.flip);
        expect(error.message).toContain("Shared-life cutover failed (request ");
        expect(input.log).toHaveBeenLastCalledWith(
          expect.objectContaining({
            stage: "preflight",
            outcome: "failed",
            code: "SHARED_LIFE_CUTOVER_FAILED",
          }),
        );
        expect(calls.every((call) => call.method === "GET")).toBe(true);
        expect((yield* client.session.get({ sessionID: first.id })).location.directory).toBe(root);
        expect((yield* client.session.get({ sessionID: second.id })).location.directory).toBe(
          secondDirectory,
        );
        yield* Effect.promise(async () => {
          await expect(
            readFile(join(personaDirectory(root, "persona1"), "persona.json")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        });
      }),
    ),
);

test("running native execution prevents any cutover writes or movement", () =>
  withRemoteHost((remote, root, { llm, transport }) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      const snapshot = yield* remote.client
        .rpc(sessionFolders)
        .read({ folderID: session.id }, { location: { directory: root } });
      yield* Effect.promise(async () => {
        await mkdir(join(root, ".opencode", "agents"), { recursive: true });
        await writeFile(join(root, ".opencode", "agents", "persona1.md"), snapshot.agent);
        await expect
          .poll(async () =>
            (
              await Effect.runPromise(remote.client.agent.list({ location: { directory: root } }))
            ).data.some((agent) => agent.id === "persona1"),
          )
          .toBe(true);
      });
      yield* remote.client.session.move({
        sessionID: session.id,
        directory: AbsolutePath.make(root),
      });
      yield* remote.sessions.wait(session.id);
      const source = yield* remote.sessions.get(session.id);
      const input = yield* pausedInput(remote.client, root, remote.personas, [source]);
      const gate = yield* llm.gate();
      yield* remote.sessions.prompt({ sessionID: session.id, text: "Work during planned pause" });
      yield* gate.started;
      transport.requests.length = 0;
      const error = yield* runSharedLifeCutover(remote.client, input).pipe(Effect.flip);
      expect(error.message).toContain("Shared-life cutover failed (request ");
      expect(input.log).toHaveBeenLastCalledWith(
        expect.objectContaining({ stage: "preflight", outcome: "failed" }),
      );
      expect(transport.requests.every((request) => request.method === "GET")).toBe(true);
      expect((yield* remote.sessions.get(session.id)).location.directory).toBe(root);
      yield* remote.sessions.interrupt(session.id);
      yield* gate.release;
      yield* remote.sessions.wait(session.id);
    }),
  ));

test("shared-life cutover detects an acknowledged native move that did not change location", () =>
  withTransferClient(({ client, root, personas, transport }) =>
    Effect.gen(function* () {
      const { session, input } = yield* singleSource(client, root, personas);
      const forward = transport.fetch;
      let moves = 0;
      transport.fetch = (request) => {
        if (!new URL(request.url).pathname.endsWith("/move")) return forward(request);
        moves++;
        return Promise.resolve(new Response(null, { status: 204 }));
      };
      const error = yield* runSharedLifeCutover(client, input).pipe(Effect.flip);
      expect(error.message).toContain("Shared-life cutover failed (request ");
      expect(input.log).toHaveBeenLastCalledWith(
        expect.objectContaining({ stage: "move-sessions", outcome: "failed" }),
      );
      expect(moves).toBe(1);
      expect((yield* client.session.get({ sessionID: session.id })).location.directory).toBe(root);
    }),
  ));

test("storage RPC failure preserves existing destination data and the source native session", () =>
  withTransferClient(({ client, root, personas }) =>
    Effect.gen(function* () {
      const { session, input } = yield* singleSource(client, root, personas);
      const target = personaDirectory(root, "persona1");
      yield* Effect.promise(async () => {
        await mkdir(join(target, "persona.json"), { recursive: true });
        await writeFile(join(target, "MEMORY.md"), "Existing data must survive");
      });
      const native = yield* client.session.export({ sessionID: session.id, sanitize: false });
      expect((yield* runSharedLifeCutover(client, input).pipe(Effect.flip)).message).toContain(
        "Shared-life cutover failed (request ",
      );
      expect(input.log).toHaveBeenLastCalledWith(
        expect.objectContaining({ stage: "restore-scopes", outcome: "failed" }),
      );
      expect(yield* Effect.promise(() => readFile(join(target, "MEMORY.md"), "utf8"))).toBe(
        "Existing data must survive",
      );
      expect(yield* client.session.export({ sessionID: session.id, sanitize: false })).toEqual(
        native,
      );
    }),
  ));

test("the shared-life command consumes both existing backups without overwriting either", () =>
  withTransferClient(({ client, root, personas }) =>
    Effect.gen(function* () {
      const { session, input } = yield* singleSource(client, root, personas);
      const file = join(root, "pre-upgrade-sessions.json");
      const applicationFile = join(root, "application-state.json");
      yield* Effect.promise(() =>
        Promise.all([
          writeFile(file, input.archive),
          writeFile(applicationFile, input.application),
        ]),
      );
      expect(
        (yield* runSessionTransfer(client, {
          operation: "shared-life",
          file,
          applicationFile,
          directory: root,
          confirmation: "yes",
        }).pipe(Effect.flip)).message,
      ).toContain("Shared-life cutover failed (request ");
      expect((yield* client.session.get({ sessionID: session.id })).location.directory).toBe(root);
      yield* runSessionTransfer(client, {
        operation: "shared-life",
        file,
        applicationFile,
        directory: root,
        personas,
        confirmation: "yes",
      });
      expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe(input.archive);
      expect(yield* Effect.promise(() => readFile(applicationFile, "utf8"))).toBe(
        input.application,
      );
      expect((yield* client.session.get({ sessionID: session.id })).location.directory).toBe(
        personaDirectory(root, "persona1"),
      );
    }),
  ));
