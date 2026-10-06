import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, type Scope } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { createHost } from "./embedded-host.test-helper.ts";
import { remoteHost } from "../src/opencode/remote.ts";
import { loadPersonas, type Persona } from "../src/personas/personas.ts";
import { messagingFixture } from "./messaging.test-helper.ts";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { AbsolutePath, Agent } from "@opencode/schema";

type Host = Effect.Success<ReturnType<typeof remoteHost>>;

/** Create a real native session at the pre-ADR-0012 root, without folder admission. */
export const legacySession = (client: Host["client"], directory: string, personaID = "persona1") =>
  client.session.create({
    agent: Agent.ID.make(personaID),
    location: { directory: AbsolutePath.make(directory) },
  });

interface Fixture {
  readonly client: Host["client"];
  readonly root: string;
  readonly calls: Array<{ method: string; path: string }>;
  readonly personas: ReadonlyMap<string, Persona>;
  readonly transport: { fetch: (request: Request) => Promise<Response> };
}

export const withTransferClient = async <A, E>(
  body: (fixture: Fixture) => Effect.Effect<A, E, Scope.Scope>,
) => {
  const { root, personaDirectory } = await messagingFixture("ren-ai-transfer-workflow-");
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const personas = yield* loadPersonas(personaDirectory);
          yield* Effect.promise(async () => {
            await mkdir(join(root, ".opencode", "agents"), { recursive: true });
            await writeFile(
              join(root, ".opencode", "agents", "persona1.md"),
              renderSnapshot(personas.get("persona1")!, "").agent,
            );
          });
          const native = yield* createHost({
            databasePath: ":memory:",
            configDirectory: join(root, "config"),
            personaDirectory: root,
            personas,
            providers: {},
            model: "test/probe",
            health: { raise: () => Effect.void },
            handleForSession: () => Effect.succeed(undefined),
          });
          const calls: Fixture["calls"] = [];
          const transport = { fetch: (request: Request) => native.web(request) };
          const host = yield* remoteHost(
            {
              baseUrl: "https://oc.test",
              authorization: "Basic workflow",
              directory: root,
              model: "test/probe",
            },
            personas,
          ).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
              const request = new Request(input, init);
              calls.push({ method: request.method, path: new URL(request.url).pathname });
              return transport.fetch(request);
            }),
          );
          return yield* body({ client: host.client, root, calls, personas, transport });
        }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
