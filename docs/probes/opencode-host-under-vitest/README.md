# Probe: OpenCode's real host inside Vitest on Node

Run on 2026-09-26 for [Server modules, seams and tables](https://github.com/hena-agent/ren-ai/issues/15).

**Question:** can the server's tests run a real in-process OpenCode 2.0.16 host with OpenCode's own scripted model, under Vitest 5 on Node 24, the way CI runs them? OpenCode's own tests do this only under `bun:test`.

## Verdict

Yes, on macOS arm64 (Node 24.15.0) and on Linux amd64 (Node 24.21.0 in the `node:24` container, with dependencies installed inside it).

| Platform    | Host start | One turn (prompt → tool → answer) | Whole file |
| ----------- | ---------: | --------------------------------: | ---------: |
| macOS arm64 |      30 ms |                            176 ms |     1.06 s |
| Linux amd64 |     116 ms |                            532 ms |     2.79 s |

- **Deny-all held.** Both execution requests offered the model only the plugin tool `send`. A third request, OpenCode's title generation, offered no tools.
- **The plugin was bound.** The tool ran with the session's ID, and the `context` hook ran twice.
- **Prompt IDs deduplicate.** Admitting `msg_probe_001` a second time caused no new model request.
- **Removal works.** After `sessions.remove`, the session was gone from the list.
- **Our own assembly works too.** A host assembled from `createEmbeddedRoutes`, keeping the web handler, answered `/openapi.json` with 200.

## Side effects to know

- **Local-model discovery.** `models: { fetch: false }` doesn't stop it. During a turn OpenCode tried `127.0.0.1:1234/api/v1/models`, `127.0.0.1:11434/api/tags` and `127.0.0.1:8000/health`. These are its LM Studio, Ollama and vLLM plugins (`opencode.provider.lmstudio`, `opencode.provider.ollama`, `opencode.provider.vllm`). Block the network in tests, and turn those plugins off in the host.
- **Native addons.** `msgpackr-extract` and `ffi-rs` were loaded. `@lydell/node-pty` was installed but not loaded.
- **Files.** OpenCode created `opencode/shell`, `opencode/repos` and `opencode/log` under the XDG roots, so tests need throwaway XDG folders. Nothing was written outside the probe's own folders.
- **Tool names.** For a namespaced plugin tool, the advertised name and the permission action are `<namespace>_<name>`.

## Files

The probe exactly as it ran. Install with `npm install`. Point `HOME` and the `XDG_*` roots at temporary folders, pass no provider keys, and load `monitor.mjs` before the tests (for example with `NODE_OPTIONS=--import=./monitor.mjs`).

`package.json`:

```json
{
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run host.test.ts --pool forks --maxWorkers 1" },
  "dependencies": {
    "@opencode/ai": "2.0.16",
    "@opencode/core": "2.0.16",
    "@opencode/plugin": "2.0.16",
    "@opencode/schema": "2.0.16",
    "@opencode/sdk": "2.0.16",
    "@opencode/server": "2.0.16",
    "effect": "4.0.0-rc.112"
  },
  "devDependencies": { "vitest": "5.0.1" }
}
```

`monitor.mjs`, which records spawns, sockets, fetches and native modules while `PROBE_ACTIVE=1`, and refuses the network:

```js
import childProcess from "node:child_process";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
const events = [];
globalThis.__probeMonitor = events;
const active = () => process.env.PROBE_ACTIVE === "1";
const spawn = childProcess.spawn;
childProcess.spawn = function (...args) {
  if (active()) events.push(["spawn", String(args[0])]);
  return spawn.apply(this, args);
};
syncBuiltinESMExports();
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  if (active()) {
    events.push(["blocked connect", String(args[0])]);
    throw new Error("Offline test: sockets disabled");
  }
  return connect.apply(this, args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = function (...args) {
  if (active()) {
    events.push(["blocked fetch", String(args[0])]);
    return Promise.reject(new Error("Offline test: network disabled"));
  }
  return originalFetch.apply(this, args);
};
const dlopen = process.dlopen;
process.dlopen = function (...args) {
  if (active()) events.push(["native", String(args[1])]);
  return dlopen.apply(this, args);
};
```

`host.test.ts`:

```ts
import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { LanguageModel, LLMClient } from "@opencode/ai";
import { OpenAIChat } from "@opencode/ai/protocols";
import { TestLLM } from "@opencode/ai/testing";
import { llmClient } from "@opencode/core/effect/app-node-platform";
import { SessionRunnerModel } from "@opencode/core/session/runner/model";
import { Plugin } from "@opencode/plugin/effect";
import { AbsolutePath, Agent, Location, OpenCode } from "@opencode/sdk/effect";
import { Effect, Layer, Schema } from "effect";

const stamp = () => Math.round(performance.now());
test("real embedded host with one allowed plugin tool", async () => {
  const directory = await mkdtemp(join(process.cwd(), "opencode-host-probe-"));
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const blockedFetches: string[] = [];
  globalThis.fetch = (input) => {
    blockedFetches.push(String(input));
    return Promise.reject(new Error("Offline test: no provider calls"));
  };
  const hooks: string[] = [];
  let started = 0;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const model = SessionRunnerModel.resolved(
            LanguageModel.make({ id: "probe", provider: "test", route: OpenAIChat.route }),
            {
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              cost: [],
              limit: { context: 100_000, output: 1_000 },
            },
          );
          const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()));
          let issued = false;
          yield* llm.serve((request) => {
            if (!issued && request.tools.some((tool) => tool.name === "send")) {
              issued = true;
              return TestLLM.tool("call-send", "send", { text: "ping" });
            }
            return TestLLM.text("done", "answer");
          });
          process.env.PROBE_ACTIVE = "1";
          const start = stamp();
          const host = yield* OpenCode.create(
            {
              database: { path: ":memory:" },
              config: { directory, project: false, content: "{}" },
              models: { fetch: false },
              fs: { filewatcher: false },
            },
            {
              overrides: [
                llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
                SessionRunnerModel.node.replace(
                  Layer.succeed(SessionRunnerModel.Service, {
                    resolve: () => Effect.succeed(model),
                  }),
                ),
              ],
            },
          );
          started = stamp() - start;
          const startupEvents = [...(globalThis.__probeMonitor ?? [])];
          console.log("STARTUP_SIDE_EFFECTS", JSON.stringify(startupEvents));
          yield* host.plugin(
            Plugin.define({
              id: "probe",
              effect: (ctx) =>
                Effect.gen(function* () {
                  yield* ctx.session.hook("context", (event) =>
                    Effect.sync(() => {
                      hooks.push(event.sessionID);
                    }),
                  );
                  yield* ctx.tool.transform((editor) =>
                    editor.add({
                      name: "send",
                      description: "Record sent text",
                      input: Schema.Struct({ text: Schema.String }),
                      output: Schema.String,
                      options: { codemode: false },
                      execute: (input, tool) =>
                        Effect.sync(() => {
                          calls.push(tool.sessionID);
                          return { output: input.text, content: input.text };
                        }),
                    }),
                  );
                }),
            }),
          );
          const session = yield* host.sessions.create({
            agent: Agent.ID.make("build"),
            model: model.ref,
            location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
            permissions: [
              { action: "*", resource: "*", effect: "deny" },
              { action: "send", resource: "*", effect: "allow" },
            ],
          });
          const prompt = { sessionID: session.id, id: "msg_probe_001", text: "Send ping" };
          const turn = stamp();
          const first = yield* host.sessions.prompt(prompt);
          yield* host.sessions.wait({ sessionID: session.id }).pipe(Effect.timeout("25 seconds"));
          const roundtrip = stamp() - turn;
          const requests = yield* llm.requests();
          const offered = requests.map((request) => request.tools.map((tool) => tool.name));
          const second = yield* host.sessions.prompt(prompt);
          const afterDuplicate = (yield* llm.requests()).length;
          expect(first.id).toBe(prompt.id);
          expect(second.id).toBe(first.id);
          expect(afterDuplicate).toBe(requests.length);
          expect(calls).toEqual([session.id]);
          expect(hooks).toContain(session.id);
          expect(offered.filter((tools) => tools.length)).toEqual([["send"], ["send"]]);
          yield* host.sessions.remove({ sessionID: session.id });
          const remaining = yield* host.sessions.list({ directory: AbsolutePath.make(directory) });
          expect(remaining.data.some((entry) => entry.id === session.id)).toBe(false);
          console.log(
            "PROBE",
            JSON.stringify({
              started,
              roundtrip,
              offered,
              calls,
              hooks: hooks.length,
              deduped: second.id === first.id && afterDuplicate === requests.length,
              removed: true,
            }),
          );
          console.log(
            "TURN_SIDE_EFFECTS",
            JSON.stringify((globalThis.__probeMonitor ?? []).slice(startupEvents.length)),
          );
          console.log("BLOCKED_PROVIDER_DISCOVERY", JSON.stringify(blockedFetches));
          console.log(
            "NATIVE_SHARED",
            JSON.stringify(
              process.report
                .getReport()
                .sharedObjects.filter((entry) =>
                  /node-pty|tree.sitter|sqlite|ffi-rs|msgpackr/i.test(entry),
                ),
            ),
          );
          process.env.PROBE_ACTIVE = "0";
        }),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env.PROBE_ACTIVE = "0";
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

test("direct server/core route assembly retains a web handler", async () => {
  const directory = await mkdtemp(join(process.cwd(), "opencode-routes-probe-"));
  const { createEmbeddedRoutes } = await import("@opencode/server/routes");
  const { Context, ManagedRuntime } = await import("effect");
  const { HttpEffect, HttpRouter, HttpServer, HttpServerRequest } =
    await import("effect/unstable/http");
  const runtime = ManagedRuntime.make(
    createEmbeddedRoutes({
      database: { path: ":memory:" },
      config: { directory, project: false, content: "{}" },
      models: { fetch: false },
      fs: { filewatcher: false },
    }).pipe(Layer.provide(HttpServer.layerServices)),
  );
  try {
    const services = await Effect.runPromise(runtime.contextEffect);
    const handler = HttpEffect.toWebHandlerWith(services)(
      Context.get(services, HttpRouter.HttpRouter).asHttpEffect(),
    );
    const response = await handler(new Request("http://opencode.local/openapi.json"));
    expect(response.status).toBe(200);
    console.log("DIRECT_HOST", JSON.stringify({ status: response.status }));
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
```
