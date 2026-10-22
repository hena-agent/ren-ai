import { copyFile, cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AbsolutePath, Agent, Location, Model, Session } from "@opencode/schema";
import { createEmbeddedRoutes } from "@opencode/server/routes";
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { expect, test } from "vitest";
import { createHost } from "../../test/embedded-host.test-helper.ts";
import { remoteHost } from "../opencode/remote.ts";
import { exportOffline } from "./offline-export.ts";
import { exportLocation } from "./session-transfer.ts";
import { sessionArchive } from "../opencode/transfer-format.ts";
import { messagingFixture } from "../../test/messaging.test-helper.ts";
import { loadPersonas } from "@ren-ai/personas";
import { sessionDirectory } from "@ren-ai/plugin-session-folder/paths";
import { folderFiles, renderSnapshot } from "@ren-ai/plugin-session-folder/files";

const testHost = (databasePath: string, personaDirectory: string, configDirectory: string) =>
  loadPersonas(personaDirectory).pipe(
    Effect.flatMap((personas) =>
      createHost({
        databasePath,
        personaDirectory,
        configDirectory,
        personas,
        providers: {},
        model: "test/probe",
        health: { raise: () => Effect.void },
        handleForSession: () => Effect.succeed(undefined),
      }),
    ),
  );

const managedSession = (
  host: Effect.Success<ReturnType<typeof testHost>>,
  directory: string,
  title: string,
  writable = true,
) =>
  Effect.gen(function* () {
    const id = Session.ID.create();
    const target = yield* Effect.promise(() =>
      folderFiles(directory).write(
        id,
        renderSnapshot(host.personas.get("persona1")!, "Archived ground rules."),
        { conversationKey: id, writable },
      ),
    );
    return yield* host.sessions.create({
      id,
      title,
      agent: Agent.ID.make("persona1"),
      model: Model.Ref.parse("test/probe"),
      location: Location.Ref.make({ directory: AbsolutePath.make(target) }),
    });
  });

const connect = (
  native: Effect.Success<ReturnType<typeof testHost>>,
  directory: string,
  fetcher: (request: Request) => Promise<Response>,
) =>
  remoteHost(
    {
      baseUrl: "https://oc.test",
      authorization: "Basic machine",
      directory,
      model: "test/probe",
      groundRules: "",
    },
    native.personas,
  ).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
      fetcher(new Request(input, init)),
    ),
  );

const readOffline = (databasePath: string, directory: string, configDirectory: string) =>
  Effect.runPromise(
    Effect.scoped(
      exportOffline(
        createEmbeddedRoutes({
          database: { path: databasePath },
          config: { directory: configDirectory, project: false },
          models: { fetch: false },
        }),
        directory,
      ),
    ),
  );

test("offline native API exporter preserves retained sessions, children and pending work without resuming it", async () => {
  const { root, personaDirectory: directory } = await messagingFixture("ren-ai-offline-export-");
  const databasePath = join(root, "opencode.sqlite");
  const copiedDatabase = join(root, "offline-copy.sqlite");
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* testHost(databasePath, directory, join(root, "config"));
          const remote = yield* connect(host, directory, host.web);
          yield* remote.client.plugin.list({ location: { directory } });
          const active = yield* managedSession(host, directory, "active");
          yield* managedSession(host, directory, "retained · reset 2026", false);
          const child = yield* host.sessions.create({ title: "child", parentID: active.id });
          yield* Effect.promise(async () => {
            await expect
              .poll(async () => (await host.run(host.sessions.get(child.id))).location.directory, {
                timeout: 5000,
              })
              .toBe(sessionDirectory(directory, child.id));
          });
          yield* host.sessions.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(root) }),
            title: "unrelated operator project",
          });
          yield* host.sessions.prompt({
            sessionID: active.id,
            text: "waiting message",
            resume: false,
          });
        }),
      ),
    );
    const original = await readFile(databasePath);
    await copyFile(databasePath, copiedDatabase);
    const exported = Schema.decodeUnknownSync(sessionArchive)(
      await readOffline(copiedDatabase, directory, join(root, "offline-config")),
    );
    expect(await readFile(databasePath)).toEqual(original);
    expect(exported.version).toBe(2);
    expect(exported.personas).toHaveLength(2);
    const retained = exported.sessions.find(
      (entry) => entry.info.title === "retained · reset 2026",
    )!;
    expect(retained.folder.binding?.writable).toBe(false);
    const child = exported.sessions.find((entry) => entry.info.title === "child")!;
    expect(exported.personas.find((persona) => persona.sandboxID === child.info.id)).toBeDefined();
    expect(exported.sessions).toHaveLength(3);
    expect(exported.sessions.map((entry) => entry.info.title)).toEqual(
      expect.arrayContaining(["active", "child", "retained · reset 2026"]),
    );
    expect(
      exported.sessions
        .find((entry) => entry.info.title === "active")
        ?.pending.map((item) => item.type),
    ).toEqual(["user"]);
    expect(
      Schema.decodeUnknownSync(sessionArchive)(
        await readOffline(":memory:", directory, join(root, "empty-config")),
      ).sessions,
    ).toEqual([]);
    const active = exported.sessions.find((entry) => entry.info.title === "active")!;
    const locator = join(directory, "personas", ".bindings", `${active.info.id}.json`);
    const binding = await readFile(locator, "utf8");
    await rm(locator);
    await expect(
      readOffline(copiedDatabase, directory, join(root, "missing-config")),
    ).rejects.toThrow(/binding|scope/);
    await expect(readFile(locator)).rejects.toMatchObject({ code: "ENOENT" });
    await cp(active.info.location.directory, sessionDirectory(directory, active.info.id), {
      recursive: true,
    });
    await writeFile(locator, JSON.stringify({ ...active.folder.binding, sandbox: true }));
    await expect(
      readOffline(copiedDatabase, directory, join(root, "incoherent-config")),
    ).rejects.toMatchObject({
      message: "Cannot inventory stopped persona scopes",
      cause: {
        message: "Session location does not match its durable persona scope",
      },
    });
    expect(await readFile(databasePath)).toEqual(original);
    await writeFile(locator, binding);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("location export walks all native pages and fails on a stuck server cursor", async () => {
  const { root, personaDirectory: directory } = await messagingFixture("ren-ai-export-pages-");
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const native = yield* testHost(":memory:", directory, join(root, "config"));
          for (let index = 0; index < 101; index++) {
            yield* managedSession(native, directory, String(index));
          }
          let stuck = false;
          const host = yield* connect(native, directory, async (request) => {
            const response = await native.web(request);
            if (!stuck) return response;
            return Response.json({ data: [], cursor: { next: "stuck" } });
          });
          expect(
            Schema.decodeUnknownSync(sessionArchive)(yield* exportLocation(host.client, directory))
              .sessions,
          ).toHaveLength(101);
          stuck = true;
          expect((yield* exportLocation(host.client, directory).pipe(Effect.flip)).message).toBe(
            "OpenCode session pagination did not advance",
          );
        }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
