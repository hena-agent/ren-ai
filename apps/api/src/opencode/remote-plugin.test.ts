import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { phone } from "@ren-ai/plugin-application/phone";
import { afterEach, expect, test, vi } from "vitest";
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
afterEach(() => vi.unstubAllEnvs());

test.each([false, true])(
  "local waits resume through an empty context response without replaying the tool (default entries: %s)",
  async (installed) => {
    const { root, personaDirectory } = await messagingFixture("plugin-wait-result-");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const now = vi.spyOn(Date, "now");
    try {
      await runMessagingTest(
        Effect.gen(function* () {
          const llm = yield* scriptedPersona();
          let attempted = false;
          yield* llm.serve((request) => {
            if (request.tools.some((tool) => tool.name === "wait") && !attempted) {
              attempted = true;
              return TestLLM.tool("local-wait", "wait", { seconds: 1 });
            }
            return TestLLM.text("observed result", "answer");
          });
          const native = yield* standaloneTestHost(root, personaDirectory, llm);
          vi.stubEnv("TOKEN_MANAGEMENT", "application-secret");
          const fixture = yield* applicationRpcFixture;
          let catalogs = 0;
          let waitAttempts = 0;
          let contextFailed = false;
          fixture.transport.fetch = async (request) => {
            const payload = Schema.decodeUnknownSync(
              Schema.fromJsonString(Schema.Struct({ id: Schema.Number, tag: Schema.String })),
            )(await request.clone().text());
            if (payload.tag === "catalog" && ++catalogs)
              return new Response("Starting", { status: 503 });
            if (payload.tag === "context" && attempted && !contextFailed) {
              contextFailed = true;
              now.mockReturnValue(Date.now() + 120_000);
              return new Response("");
            }
            if (payload.tag !== "wait") return fixture.web.handler(request);
            waitAttempts++;
            throw new Error("Wait must stay local");
          };
          const config = {
            directory: personaDirectory,
            url: "https://app.test/rpc",
            token: "application-secret",
          };
          const plugin = installed
            ? installedPlugins.map((entry) => withPluginOptions(entry, config))
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
            .filter((part) => part.id === "local-wait")
            .map((part) => part.result);
          expect(results).toHaveLength(1);
          expect(results[0]).toEqual({ type: "text", value: "paused 1s" });
          expect(contextFailed).toBe(true);
          const resumed = (yield* llm.requests()).at(-1)!;
          expect(
            resumed.messages
              .flatMap((message) => message.content)
              .filter((part) => part.type === "text")
              .map((part) => part.text),
          ).toContain(phone(Date.now(), fixture.persona.timeZone, "sent"));
          const errors = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
          const summaries = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
          const requestId = errors.match(/"requestId":"([0-9a-f-]{36})"/)?.[1];
          expect(requestId).toBeDefined();
          expect(errors).toContain('"causeName":"RpcClientDefect"');
          expect(errors).toContain('"stage":"context.prepare"');
          expect(errors).not.toContain("application-secret");
          expect(errors).not.toContain("wait, then inspect the result");
          expect(summaries).toContain(`"requestId":"${requestId}"`);
          expect(summaries).toContain('"outcome":"succeeded"');
          expect(waitAttempts).toBe(0);
          expect(catalogs).toBe(0);
          const beforeMismatch = (yield* llm.requests()).length;
          yield* Effect.promise(() =>
            writeFile(
              join(session.location.directory, "persona.json"),
              JSON.stringify({ ...fixture.persona, id: "different-persona" }),
            ),
          );
          expect(
            yield* remote.sessions
              .prompt({
                sessionID: session.id,
                text: "a non-matching snapshot must fail closed",
              })
              .pipe(Effect.flip),
          ).toBeInstanceOf(Error);
          expect(yield* remote.sessions.inbox(session.id)).toEqual([]);
          expect(yield* llm.requests()).toHaveLength(beforeMismatch);
        }),
      );
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
      now.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("default entries skip root and unrelated locations without management credentials", async () => {
  vi.stubEnv("TOKEN_MANAGEMENT", undefined);
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
          ).toEqual(installedPlugins.map(() => "active"));
        }
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["options", "token"])(
  "invalid plugin %s fails closed before calling the application",
  async (invalid) => {
    vi.stubEnv("TOKEN_MANAGEMENT", undefined);
    const { root, personaDirectory } = await messagingFixture("plugin-options-");
    try {
      await runMessagingTest(
        Effect.gen(function* () {
          const llm = yield* scriptedPersona();
          yield* llm.serve(() => TestLLM.text("ordinary", "answer"));
          const native = yield* standaloneTestHost(root, personaDirectory, llm);
          yield* registerInstalledPlugin(native, installedPlugin, {
            directory: invalid === "options" ? 1 : personaDirectory,
            url: "https://app.test/rpc",
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
          expect(body).toContain(invalid === "options" ? "directory" : "TOKEN_MANAGEMENT");
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
