import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, Location } from "@opencode/schema";
import { createEmbeddedRoutes } from "@opencode/server/routes";
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { expect, test } from "vitest";
import { createHost } from "../../test/embedded-host.test-helper.ts";
import { remoteHost } from "../opencode/remote.ts";
import { exportOffline } from "./offline-export.ts";
import { exportLocation } from "./session-transfer.ts";

const archive = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Number,
    sessions: Schema.Array(
      Schema.Struct({
        info: Schema.Struct({ id: Schema.String, title: Schema.String }),
        pending: Schema.Array(Schema.Struct({ type: Schema.String })),
      }),
    ),
  }),
);

const testHost = (databasePath: string, personaDirectory: string, configDirectory: string) =>
  createHost({
    databasePath,
    personaDirectory,
    configDirectory,
    personas: new Map(),
    providers: {},
    model: "test/probe",
    health: { raise: () => Effect.void },
    handleForSession: () => Effect.succeed(undefined),
  });

test("offline native API exporter preserves retained sessions, children and pending work without resuming it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ren-ai-offline-export-"));
  const databasePath = join(root, "opencode.sqlite");
  const directory = join(root, "old-personas");
  await mkdir(directory);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* testHost(databasePath, directory, join(root, "config"));
          const location = Location.Ref.make({ directory: AbsolutePath.make(directory) });
          const active = yield* host.sessions.create({ location, title: "active" });
          yield* host.sessions.create({ location, title: "retained · reset 2026" });
          yield* host.sessions.create({ title: "child", parentID: active.id });
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
    const exported = Schema.decodeUnknownSync(archive)(
      await Effect.runPromise(
        Effect.scoped(
          exportOffline(
            createEmbeddedRoutes({
              database: { path: databasePath },
              config: { directory: join(root, "offline-config"), project: false },
              models: { fetch: false },
            }),
            directory,
          ),
        ),
      ),
    );
    expect(exported.version).toBe(1);
    expect(exported.sessions.map((entry) => entry.info.title).toSorted()).toEqual([
      "active",
      "child",
      "retained · reset 2026",
    ]);
    expect(
      exported.sessions
        .find((entry) => entry.info.title === "active")
        ?.pending.map((item) => item.type),
    ).toEqual(["user"]);
    expect(
      Schema.decodeUnknownSync(archive)(
        await Effect.runPromise(
          Effect.scoped(
            exportOffline(
              createEmbeddedRoutes({
                database: { path: ":memory:" },
                config: { directory: join(root, "empty-config") },
                models: { fetch: false },
              }),
              directory,
            ),
          ),
        ),
      ).sessions,
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("location export walks all native pages and fails on a stuck server cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "ren-ai-export-pages-"));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const native = yield* testHost(":memory:", root, join(root, "config"));
          const location = Location.Ref.make({ directory: AbsolutePath.make(root) });
          for (let index = 0; index < 101; index++)
            yield* native.sessions.create({ location, title: String(index) });
          let stuck = false;
          const host = yield* remoteHost(
            {
              baseUrl: "https://oc.test",
              authorization: "Basic machine",
              directory: root,
              model: "test/probe",
            },
            new Map(),
          ).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, async (input, init) => {
              const response = await native.web(new Request(input, init));
              if (!stuck) return response;
              return Response.json({ data: [], cursor: { next: "stuck" } });
            }),
          );
          expect(
            Schema.decodeUnknownSync(archive)(yield* exportLocation(host.client, root)).sessions,
          ).toHaveLength(101);
          stuck = true;
          expect((yield* exportLocation(host.client, root).pipe(Effect.flip)).message).toBe(
            "OpenCode export pagination did not advance",
          );
        }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
