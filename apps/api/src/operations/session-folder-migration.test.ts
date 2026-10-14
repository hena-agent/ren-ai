import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AbsolutePath, Agent, Session } from "@opencode/schema";
import { SessionMessage } from "@opencode/schema/session-message";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { sessionDirectory } from "@ren-ai/plugin-session-folder/paths";
import { legacySession, withTransferClient } from "../../test/operations-transfer.test-helper.ts";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";
import { sessionArchive } from "../opencode/transfer-format.ts";
import { exportLocation, runSessionTransfer } from "./session-transfer.ts";

test("paused migration preserves legacy and retained history, snapshots existing folders, and excludes unrelated projects across pages", () =>
  withTransferClient(({ client, root, personas, calls }) =>
    Effect.gen(function* () {
      const active = yield* client.session.create({
        agent: Agent.ID.make("persona1"),
        title: "current Conversation",
        location: { directory: AbsolutePath.make(root) },
      });
      const retained = yield* client.session.create({
        agent: Agent.ID.make("persona1"),
        title: "persona1 · reset yesterday",
        location: { directory: AbsolutePath.make(root) },
      });
      yield* client.session.remove({ sessionID: retained.id });
      yield* client.session.import({
        info: Session.Info.make(Object.assign({}, retained, { parentID: active.id })),
        location: retained.location,
        messages: [
          SessionMessage.Synthetic.make({
            id: SessionMessage.ID.make("msg_retained_memory"),
            time: { created: retained.time.created },
            text: "His old Memory stays here.",
          }),
        ],
      });
      const before = yield* client.session.export({ sessionID: retained.id, sanitize: false });
      const managedID = Session.ID.create();
      const managed = yield* client.rpc(sessionFolders).write(
        {
          folderID: managedID,
          snapshot: renderSnapshot(personas.get("persona1")!, "Retained historical ground rules."),
        },
        { location: { directory: root } },
      );
      const original = yield* client
        .rpc(sessionFolders)
        .read({ folderID: managedID }, { location: { directory: root } });
      yield* client.session.create({
        id: managedID,
        agent: Agent.ID.make("persona1"),
        location: { directory: AbsolutePath.make(managed) },
      });
      const elsewhere = join(root, "operator-project");
      yield* Effect.promise(() => mkdir(elsewhere));
      for (let index = 0; index < 101; index++)
        yield* client.session.create({
          title: `unrelated ${index}`,
          location: { directory: AbsolutePath.make(elsewhere) },
        });
      const wrongFolder = join(root, "sessions", "not-a-session-id");
      yield* Effect.promise(() => mkdir(wrongFolder));
      const unrelated = yield* client.session.create({
        location: { directory: AbsolutePath.make(wrongFolder) },
      });
      calls.length = 0;
      const file = join(root, "pre-cutover.json");
      yield* runSessionTransfer(client, {
        operation: "folders",
        file,
        directory: root,
        confirmation: "yes",
        personas,
      });
      const evidence = Schema.decodeUnknownSync(sessionArchive)(
        yield* Effect.promise(() => readFile(file, "utf8")),
      );
      expect(evidence.sessions.map((entry) => entry.info.id).toSorted()).toEqual(
        [active.id, retained.id, managedID].toSorted(),
      );
      expect(
        evidence.sessions.find((entry) => entry.info.id === retained.id)?.info.location.directory,
      ).toBe(root);
      expect(evidence.sessions.find((entry) => entry.info.id === managedID)?.folder).toEqual(
        original,
      );
      expect((yield* Effect.promise(() => stat(file))).mode & 0o777).toBe(0o600);
      expect(calls.filter((call) => call.path === "/api/session").length).toBeGreaterThan(2);
      const after = yield* client.session.export({ sessionID: retained.id, sanitize: false });
      expect(after.info).toMatchObject({
        id: retained.id,
        agent: "persona1",
        title: "persona1 · reset yesterday",
        parentID: active.id,
        location: { directory: sessionDirectory(root, retained.id) },
      });
      expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
      expect(after.messages.slice(before.messages.length).map((message) => message.type)).toEqual([
        "location-switched",
        "idle",
      ]);
      expect((yield* client.session.get({ sessionID: active.id })).location.directory).toBe(
        sessionDirectory(root, active.id),
      );
      expect((yield* client.session.get({ sessionID: unrelated.id })).location.directory).toBe(
        wrongFolder,
      );
      expect(
        yield* client
          .rpc(sessionFolders)
          .read({ folderID: managedID }, { location: { directory: root } }),
      ).toEqual(original);
      yield* runSessionTransfer(client, {
        operation: "folders",
        file: join(root, "second-evidence.json"),
        directory: root,
        confirmation: "yes",
      });
      const exported = Schema.decodeUnknownSync(sessionArchive)(
        yield* exportLocation(client, root),
      );
      expect(exported.sessions).toHaveLength(3);
      expect(exported.sessions.every((entry) => entry.folder?.persona.id === "persona1")).toBe(
        true,
      );
    }),
  ));

test.each(["catalog", "queued"] as const)(
  "migration preflights every legacy session before writing any folder (%s)",
  (blocked) =>
    withTransferClient(({ client, root, personas, calls }) =>
      Effect.gen(function* () {
        const first = yield* legacySession(client, root);
        const second = yield* legacySession(
          client,
          root,
          blocked === "catalog" ? "missing" : "persona1",
        );
        if (blocked === "queued")
          yield* client.session.prompt({
            sessionID: second.id,
            text: "queued work",
            resume: false,
          });
        calls.length = 0;
        const file = join(root, "rejected-migration.json");
        const error = yield* runSessionTransfer(client, {
          operation: "folders",
          file,
          directory: root,
          confirmation: "yes",
          personas,
        }).pipe(Effect.flip);
        expect(error.message).toContain(
          blocked === "catalog" ? "Missing persona" : "drain queued work",
        );
        expect(
          Schema.decodeUnknownSync(sessionArchive)(
            yield* Effect.promise(() => readFile(file, "utf8")),
          ).sessions,
        ).toHaveLength(2);
        expect(calls.every((call) => call.method === "GET")).toBe(true);
        for (const session of [first, second])
          expect((yield* client.session.get({ sessionID: session.id })).location.directory).toBe(
            root,
          );
      }),
    ),
);

test("running native execution must be interrupted before a session can move", () =>
  withRemoteHost((remote, root, { llm }) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      const snapshot = yield* remote.client
        .rpc(sessionFolders)
        .read({ folderID: session.id }, { location: { directory: root } });
      yield* Effect.promise(async () => {
        await mkdir(join(root, ".opencode", "agents"), { recursive: true });
        await writeFile(join(root, ".opencode", "agents", "persona1.md"), snapshot.agent);
      });
      yield* Effect.promise(async () => {
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
      const gate = yield* llm.gate();
      yield* remote.sessions.prompt({ sessionID: session.id, text: "work during planned pause" });
      yield* gate.started;
      const input = {
        operation: "folders" as const,
        file: join(root, "running.json"),
        directory: root,
        confirmation: "yes",
        personas: remote.personas,
      };
      expect((yield* runSessionTransfer(remote.client, input).pipe(Effect.flip)).message).toContain(
        "Interrupt running sessions",
      );
      expect((yield* remote.sessions.get(session.id)).location.directory).toBe(root);
      yield* remote.sessions.interrupt(session.id);
      yield* gate.release;
      yield* remote.sessions.wait(session.id);
      yield* runSessionTransfer(remote.client, { ...input, file: join(root, "interrupted.json") });
      expect((yield* remote.sessions.get(session.id)).location.directory).toBe(
        sessionDirectory(root, session.id),
      );
    }),
  ));

test("migration rejects an acknowledged move that did not change the native session location", () =>
  withTransferClient(({ client, root, personas, transport }) =>
    Effect.gen(function* () {
      const session = yield* legacySession(client, root);
      const forward = transport.fetch;
      transport.fetch = (request) =>
        new URL(request.url).pathname.endsWith("/move")
          ? Promise.resolve(new Response(null, { status: 204 }))
          : forward(request);
      expect(
        (yield* runSessionTransfer(client, {
          operation: "folders",
          file: join(root, "unmoved.json"),
          directory: root,
          confirmation: "yes",
          personas,
        }).pipe(Effect.flip)).message,
      ).toContain(`Session ${session.id} did not move`);
      expect((yield* client.session.get({ sessionID: session.id })).location.directory).toBe(root);
    }),
  ));

test("folder RPC failures preserve migration evidence and never move a session", () =>
  withTransferClient(({ client, root, personas }) =>
    Effect.gen(function* () {
      const session = yield* legacySession(client, root);
      yield* Effect.promise(() =>
        mkdir(join(sessionDirectory(root, session.id), "persona.json"), { recursive: true }),
      );
      const file = join(root, "failed-write.json");
      expect(
        (yield* runSessionTransfer(client, {
          operation: "folders",
          file,
          directory: root,
          confirmation: "yes",
          personas,
        }).pipe(Effect.flip)).message,
      ).toContain("Cannot write session folder");
      expect(
        Schema.decodeUnknownSync(sessionArchive)(
          yield* Effect.promise(() => readFile(file, "utf8")),
        ).sessions[0]?.info.id,
      ).toBe(session.id);
      expect((yield* client.session.get({ sessionID: session.id })).location.directory).toBe(root);
    }),
  ));
