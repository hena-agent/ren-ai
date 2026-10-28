import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { executionBindings } from "./execution-bindings.ts";
import { Schema } from "effect";

let source: Promise<string> | undefined;
export const executionWorker = async (persistence: string, executor: string, directory: string) => {
  source ??= build({
    entryPoints: [new URL("./execution-worker-entry.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker"],
    mainFields: ["module", "main"],
    loader: { ".md": "text" },
    target: "es2023",
    external: ["cloudflare:workers", "node:*"],
  }).then((result) => result.outputFiles[0]!.text);
  const contents = await source;
  return new Miniflare({
    resourcePersistencePath: persistence,
    workers: [
      {
        config: {
          name: "execution-proof",
          compatibilityDate: "2026-10-13",
          compatibilityFlags: ["nodejs_compat"],
          exports: {
            ExecutionApplication: { type: "durable-object", storage: "sqlite" },
            HealthMonitor: { type: "durable-object", storage: "sqlite" },
          },
          manifest: {
            mainModule: "execution.js",
            modules: { "execution.js": { type: "esm", contents } },
          },
          env: {
            ...Object.fromEntries(
              Object.entries({
                ...executionBindings,
                TEST_EXECUTOR_URL: executor,
                OPENCODE_DIRECTORY: directory,
                PERSONA_MODEL: "test/probe",
              }).map(([key, value]) => [key, { type: "text" as const, value }]),
            ),
            APPLICATION: {
              type: "durable-object",
              worker: "execution-proof",
              exportName: "ExecutionApplication",
            },
            MONITOR: {
              type: "durable-object",
              worker: "execution-proof",
              exportName: "HealthMonitor",
            },
          },
        },
      },
    ],
  });
};

const State = Schema.Struct({
  catalogReads: Schema.Number,
  alarm: Schema.NullOr(Schema.Number),
  contacts: Schema.Array(
    Schema.Struct({ state: Schema.String, session_id: Schema.NullOr(Schema.String) }),
  ),
  conversations: Schema.Array(
    Schema.Struct({ session_id: Schema.String, persona_id: Schema.String }),
  ),
  sends: Schema.Array(
    Schema.Struct({ state: Schema.String, tool_call_id: Schema.NullOr(Schema.String) }),
  ),
  notifications: Schema.Array(Schema.Struct({ state: Schema.String })),
});
export const executionState = async (runtime: Miniflare, path = "/__fixture/state") => {
  const response = await runtime.dispatchFetch(`https://app${path}`);
  if (!response.ok) throw new Error(await response.text());
  return Schema.decodeUnknownSync(State)(await response.json());
};
