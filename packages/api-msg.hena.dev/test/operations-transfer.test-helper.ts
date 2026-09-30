import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { createHost } from "./embedded-host.test-helper.ts";
import { remoteHost } from "../src/opencode/remote.ts";

type Host = Effect.Success<ReturnType<typeof remoteHost>>;
interface Fixture {
  readonly client: Host["client"];
  readonly root: string;
  readonly calls: Array<{ method: string; path: string }>;
}

export const withTransferClient = async <A, E>(body: (fixture: Fixture) => Effect.Effect<A, E>) => {
  const root = await mkdtemp(join(tmpdir(), "ren-ai-transfer-workflow-"));
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const native = yield* createHost({
            databasePath: ":memory:",
            configDirectory: join(root, "config"),
            personaDirectory: root,
            personas: new Map(),
            providers: {},
            model: "test/probe",
            health: { raise: () => Effect.void },
            handleForSession: () => Effect.succeed(undefined),
          });
          const calls: Fixture["calls"] = [];
          const host = yield* remoteHost(
            {
              baseUrl: "https://oc.test",
              authorization: "Basic workflow",
              directory: root,
              model: "test/probe",
            },
            new Map(),
          ).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
              const request = new Request(input, init);
              calls.push({ method: request.method, path: new URL(request.url).pathname });
              return native.web(request);
            }),
          );
          return yield* body({ client: host.client, root, calls });
        }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
