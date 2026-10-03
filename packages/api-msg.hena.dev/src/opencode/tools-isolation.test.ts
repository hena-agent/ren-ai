import { rm } from "node:fs/promises";
import { Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { expect, test } from "vitest";
import { contextPlugin } from "@ren-ai/plugin-context";
import { messagingToolDefinitions } from "@ren-ai/plugin-application";
import { messagingFixture, runMessagingTest } from "../../test/messaging.test-helper.ts";
import { scriptedPersona, standaloneTestHost } from "../../test/messaging-host.test-helper.ts";
import { allowAllSessionTools, localOpenCode } from "../../test/server.test-helper.ts";

test.each(["absent", "failed", "wrong-schema"] as const)(
  "context removes builtin filesystem read when the messaging tools are %s",
  async (mode) => {
    const { root, personaDirectory } = await messagingFixture("tools-isolation-");
    try {
      await runMessagingTest(
        Effect.gen(function* () {
          const llm = yield* scriptedPersona();
          yield* llm.serve(() => TestLLM.text("no filesystem access", "answer"));
          const native = yield* standaloneTestHost(root, personaDirectory, llm);
          yield* Effect.promise(() =>
            native.run(
              native.plugins.register(
                Plugin.define({
                  id: "ren-ai.tools",
                  effect: (ctx) =>
                    mode === "failed"
                      ? Effect.die(new Error("Messaging module failed"))
                      : mode === "wrong-schema"
                        ? ctx.tool
                            .transform((editor) =>
                              editor.update("read", (tool) => {
                                tool.description = messagingToolDefinitions.read.description;
                              }),
                            )
                            .pipe(Effect.asVoid)
                        : Effect.void,
                }),
              ),
            ),
          );
          const removed: string[] = [];
          let beforeCleanup = "";
          let reads = 0;
          const plugin = contextPlugin({
            personaDirectory,
            personas: native.personas,
            handleForSession: () => Effect.succeed(undefined),
            read: () =>
              Effect.sync(() => {
                reads++;
                return "marked read";
              }),
            health: {
              raise: (_, detail) =>
                Effect.sync(() => {
                  removed.push(detail);
                }),
            },
          });
          yield* Effect.promise(() =>
            native.run(
              native.plugins.register({
                ...plugin,
                effect: (ctx) =>
                  Effect.gen(function* () {
                    yield* ctx.session.hook("context", (event) =>
                      Effect.sync(() => {
                        beforeCleanup = event.tools["read"]?.description ?? "";
                      }),
                    );
                    yield* plugin.effect(ctx);
                  }),
              }),
            ),
          );
          const session = yield* native.createSession("persona1");
          const remote = yield* localOpenCode(native, personaDirectory);
          yield* allowAllSessionTools(remote, session.id);
          yield* remote.sessions.prompt({
            sessionID: session.id,
            text: "A permissive read rule must not expose filesystem read.",
          });
          yield* remote.sessions.wait(session.id);
          expect(beforeCleanup).not.toBe("");
          const requests = yield* llm.requests();
          expect(requests.length).toBeGreaterThan(0);
          expect(
            requests.every((request) => request.tools.every((tool) => tool.name !== "read")),
          ).toBe(true);
          expect(removed).toContain("OpenCode offered disallowed tool: read");
          expect(reads).toBe(0);
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
