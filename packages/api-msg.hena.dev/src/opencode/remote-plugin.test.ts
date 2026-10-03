import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { expect, test } from "vitest";
import { messagingFixture, runMessagingTest } from "../../test/messaging.test-helper.ts";
import {
  ordinaryProjectHost,
  scriptedPersona,
  standaloneTestHost,
} from "../../test/messaging-host.test-helper.ts";
import { applicationRpcFixture } from "../../test/application-rpc.test-helper.ts";
import {
  localOpenCode,
  registerApplicationPlugin,
  allowAllSessionTools,
  unrelatedSession,
} from "../../test/server.test-helper.ts";
import {
  installedPlugins,
  remotePersonaPlugins,
  registerInstalledPlugin,
  withPluginOptions,
} from "../../test/persona-plugins.test-helper.ts";

const installedPlugin = installedPlugins[0]!;

test.each([false, true])(
  "the plugins validate wait results without catalog loading (default entries: %s)",
  async (installed) => {
    const { root, personaDirectory } = await messagingFixture("plugin-wait-result-");
    const tokenFile = join(root, "application-token");
    await writeFile(tokenFile, "\napplication-secret\n");
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
            if (payload.tag === "catalog" && ++catalogs)
              return new Response("Starting", { status: 503 });
            if (payload.tag !== "wait") return fixture.web.handler(request);
            return new Response(
              `${JSON.stringify({ _tag: "Chunk", requestId: payload.id, values: [""] })}\n${JSON.stringify({ _tag: "Exit", requestId: payload.id, exit: { _tag: "Success", value: null } })}\n`,
            );
          };
          const config = {
            directory: personaDirectory,
            url: "https://app.test/rpc",
            token: "application-secret",
          };
          const plugin = installed
            ? installedPlugins.map((entry) => withPluginOptions(entry, { ...config, tokenFile }))
            : remotePersonaPlugins(config);
          yield* registerApplicationPlugin(native, plugin, (input, init) =>
            fixture.transport.fetch(new Request(input, init)),
          );
          const remote = yield* localOpenCode(native, personaDirectory);
          const session = yield* native.createSession("persona1");
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
          expect(catalogs).toBe(0);
          const beforeMismatch = (yield* llm.requests()).length;
          yield* Effect.promise(() =>
            writeFile(
              join(session.location.directory, "persona.json"),
              JSON.stringify({ ...fixture.persona, id: "different-persona" }),
            ),
          );
          yield* remote.sessions.prompt({
            sessionID: session.id,
            text: "a non-matching snapshot must fail closed",
          });
          yield* remote.sessions.wait(session.id);
          expect((yield* remote.sessions.get(session.id)).outcome).toBe("failed");
          expect(yield* llm.requests()).toHaveLength(beforeMismatch);
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("default entries skip root and unrelated locations without opening their token file", async () => {
  const { root, personaDirectory } = await messagingFixture("plugin-default-scope-");
  const unrelated = join(root, "other-project");
  await mkdir(unrelated);
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const { native } = yield* ordinaryProjectHost(root, personaDirectory);
        yield* registerApplicationPlugin(
          native,
          installedPlugins.map((entry) =>
            withPluginOptions(entry, {
              directory: personaDirectory,
              url: "https://unused.test/rpc",
              tokenFile: "/not-used",
            }),
          ),
          () => Promise.reject(new Error("Unexpected callback")),
        );
        const remote = yield* localOpenCode(native, personaDirectory);
        for (const directory of [personaDirectory, unrelated]) {
          expect((yield* unrelatedSession(remote.client, directory)).outcome).toBe("succeeded");
          const plugins = yield* remote.client.plugin.list({
            location: { directory },
          });
          expect(
            plugins.data
              .filter((entry) => installedPlugins.some((plugin) => plugin.id === entry.id))
              .map((entry) => entry.state.status),
          ).toEqual(["active", "active", "active", "active"]);
        }
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed installed plugin options are reported as a failed plugin, not an inactive directory match", async () => {
  const { root, personaDirectory } = await messagingFixture("plugin-options-");
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const llm = yield* scriptedPersona();
        yield* llm.serve(() => TestLLM.text("ordinary", "answer"));
        const native = yield* standaloneTestHost(root, personaDirectory, llm);
        yield* registerInstalledPlugin(native, installedPlugin, {
          directory: 1,
          url: "https://app.test/rpc",
          tokenFile: "/not-used",
        });
        const remote = yield* localOpenCode(native, personaDirectory);
        const session = yield* native.createSession("persona1");
        yield* remote.sessions.prompt({
          sessionID: session.id,
          text: "initialize configured plugins",
        });
        yield* remote.sessions.wait(session.id).pipe(Effect.timeout("5 seconds"));
        const body = JSON.stringify(
          yield* remote.client.plugin.list({ location: session.location }),
        );
        expect(body).toContain('"status":"failed"');
        expect(body).toContain("directory");
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
