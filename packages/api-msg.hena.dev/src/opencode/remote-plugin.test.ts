import { rm } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { expect, test } from "vitest";
import { messagingFixture, runMessagingTest } from "../../test/messaging.test-helper.ts";
import { scriptedPersona, standaloneTestHost } from "../../test/messaging-host.test-helper.ts";
import { applicationRpcFixture } from "../../test/application-rpc.test-helper.ts";
import {
  localOpenCode,
  registerApplicationPlugin,
  allowAllSessionTools,
} from "../../test/server.test-helper.ts";
import installedPlugin, { remotePersonaPlugin } from "./remote-plugin.ts";

test.each([false, true])(
  "the installed plugin recovers startup and validates wait results (callback initially unavailable: %s)",
  async (unavailable) => {
    const { root, personaDirectory } = await messagingFixture("plugin-wait-result-");
    try {
      await runMessagingTest(
        Effect.gen(function* () {
          const llm = yield* scriptedPersona();
          let attempted = false;
          yield* llm.serve((request) => {
            if (request.tools.some((tool) => tool.name === "wait") && !attempted) {
              attempted = true;
              return TestLLM.tool("heartbeat-only", "wait", { minutes: 1 });
            }
            return TestLLM.text("observed result", "answer");
          });
          const native = yield* standaloneTestHost(root, personaDirectory, llm);
          const fixture = yield* applicationRpcFixture;
          let catalogs = 0;
          fixture.transport.fetch = async (request) => {
            const payload = Schema.decodeUnknownSync(
              Schema.fromJsonString(Schema.Struct({ id: Schema.Number, tag: Schema.String })),
            )(await request.clone().text());
            if (payload.tag === "catalog" && ++catalogs === 1 && unavailable)
              return new Response("Starting", { status: 503 });
            if (payload.tag !== "wait") return fixture.web.handler(request);
            return new Response(
              `${JSON.stringify({ _tag: "Chunk", requestId: payload.id, values: [""] })}\n${JSON.stringify({ _tag: "Exit", requestId: payload.id, exit: { _tag: "Success", value: null } })}\n`,
            );
          };
          const plugin = remotePersonaPlugin({
            directory: personaDirectory,
            url: "https://app.test/rpc",
            token: "application-secret",
          });
          yield* registerApplicationPlugin(native, plugin, (input, init) =>
            fixture.transport.fetch(new Request(input, init)),
          );
          const remote = yield* localOpenCode(native, personaDirectory);
          const session = yield* remote.createSession("persona1");
          yield* allowAllSessionTools(remote, session.id);
          yield* remote.sessions.prompt({
            sessionID: session.id,
            text: "wait, then inspect the result",
          });
          yield* remote.sessions.wait(session.id).pipe(Effect.timeout("5 seconds"));
          const results = (yield* llm.requests())
            .flatMap((request) => request.messages)
            .flatMap((message) => message.content)
            .filter((part) => part.type === "tool-result")
            .filter((part) => part.id === "heartbeat-only")
            .map((part) => part.result);
          expect(results).toHaveLength(1);
          expect(results[0]).toMatchObject({ type: "error" });
          expect(JSON.stringify(results)).toContain("Wait stream ended without a result");
          expect(catalogs).toBe(unavailable ? 2 : 1);
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("malformed installed plugin options are reported as a failed plugin, not an inactive directory match", async () => {
  const { root, personaDirectory } = await messagingFixture("plugin-options-");
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const llm = yield* scriptedPersona();
        yield* llm.serve(() => TestLLM.text("ordinary", "answer"));
        const native = yield* standaloneTestHost(root, personaDirectory, llm);
        yield* Effect.promise(() =>
          native.run(
            native.plugins.register({
              ...installedPlugin,
              effect: (ctx) =>
                installedPlugin.effect({
                  ...ctx,
                  options: { directory: 1, url: "https://app.test/rpc", tokenFile: "/not-used" },
                }),
            }),
          ),
        );
        const remote = yield* localOpenCode(native, personaDirectory);
        const session = yield* remote.createSession("persona1");
        yield* remote.sessions.prompt({
          sessionID: session.id,
          text: "initialize configured plugins",
        });
        yield* remote.sessions.wait(session.id).pipe(Effect.timeout("5 seconds"));
        const body = JSON.stringify(
          yield* remote.client.plugin.list({ location: { directory: personaDirectory } }),
        );
        expect(body).toContain('"status":"failed"');
        expect(body).toContain("directory");
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
