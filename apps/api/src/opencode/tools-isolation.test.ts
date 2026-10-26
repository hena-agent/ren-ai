import { rm } from "node:fs/promises";
import { Plugin } from "@opencode/plugin/effect";
import { Effect, Schema } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { expect, test } from "vitest";
import { contextPlugin } from "@ren-ai/plugin-context";
import { messagingToolDefinitions } from "@ren-ai/plugin-application";
import { messagingFixture, runMessagingTest } from "../../test/messaging.test-helper.ts";
import { scriptedPersona, standaloneTestHost } from "../../test/messaging-host.test-helper.ts";
import { allowAllSessionTools, localOpenCode } from "../../test/server.test-helper.ts";

test.each(
  (["read", "take_photo", "send_photo"] as const).flatMap((name) =>
    (["absent", "failed", "wrong-schema"] as const).map((mode) => ({ name, mode })),
  ),
)("context removes $name when the messaging tool is $mode", async ({ name, mode }) => {
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
                            editor.add({
                              name,
                              description: messagingToolDefinitions[name].description,
                              input: Schema.Struct({ path: Schema.String }),
                              output: Schema.String,
                              options: { codemode: false },
                              execute: () => Effect.succeed({ content: "must not run" }),
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
          takePhoto: () => Effect.succeed({ status: "declined" }),
          sendPhoto: () => Effect.succeed("not sent: unavailable"),
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
                      beforeCleanup = event.tools[name]?.description ?? "";
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
        if (name === "read" || mode === "wrong-schema") expect(beforeCleanup).not.toBe("");
        const requests = yield* llm.requests();
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every((request) => request.tools.every((tool) => tool.name !== name))).toBe(
          true,
        );
        if (beforeCleanup) expect(removed).toContain(`OpenCode offered disallowed tool: ${name}`);
        expect(reads).toBe(0);
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
