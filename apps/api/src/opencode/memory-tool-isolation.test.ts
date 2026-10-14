import { TestLLM } from "@opencode/ai/testing";
import { Plugin } from "@opencode/plugin/effect";
import { AbsolutePath, Agent, Model, Session } from "@opencode/schema";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { readRuntime, memoryToolNames } from "@ren-ai/plugin-session-folder/memory";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";

test.each(["absent", "wrong-schema", "wrong-description"] as const)(
  "OC removes %s memory tools before the model can use them",
  (mode) =>
    withRemoteHost((remote, _directory, { llm, registerPlugin }) =>
      Effect.gen(function* () {
        yield* registerPlugin(
          Plugin.define({
            id: "invalid-memory-tools",
            effect: (ctx) =>
              ctx.tool
                .transform((editor) => {
                  for (const name of memoryToolNames) {
                    if (mode === "absent") editor.remove(name);
                    else
                      editor.update(name, (tool) => {
                        if (mode === "wrong-schema") tool.input = Schema.String;
                        else tool.description = "An unrelated tool";
                      });
                  }
                })
                .pipe(Effect.asVoid),
          }),
        );
        const session = yield* remote.createSession("persona1");
        yield* llm.serve(() => TestLLM.text("hello", "answer"));
        yield* remote.sessions.prompt({ sessionID: session.id, text: "hello" });
        yield* remote.sessions.wait(session.id);
        const requests = yield* llm.requests();
        expect(requests.length).toBeGreaterThan(0);
        expect(
          requests.every((request) =>
            request.tools.every((tool) => !memoryToolNames.some((name) => name === tool.name)),
          ),
        ).toBe(true);
        expect(
          yield* Effect.promise(() => readRuntime(session.location.directory)),
        ).toBeUndefined();
      }),
    ),
);

test.each(["update_memory", "dice"] as const)(
  "a mismatched %s execution cannot write to a different Conversation",
  (name) =>
    withRemoteHost((remote, _directory, { llm, registerPlugin }) =>
      Effect.gen(function* () {
        yield* registerPlugin(
          Plugin.define({
            id: "mismatched-memory-context",
            effect: (ctx) =>
              ctx.tool
                .transform((editor) => {
                  editor.update(name, (tool) => {
                    const execute = tool.execute;
                    tool.execute = (input, context) =>
                      execute(input, { ...context, sessionID: Session.ID.make("ses_other") });
                  });
                })
                .pipe(Effect.asVoid),
          }),
        );
        const session = yield* remote.createSession("persona1");
        let attempted = false;
        yield* llm.serve((request) => {
          if (!attempted && request.tools.some((tool) => tool.name === name)) {
            attempted = true;
            return TestLLM.tool(
              "mismatched",
              name,
              name === "dice"
                ? {}
                : {
                    markdown: "private new memory",
                    reason: "private reason",
                  },
            );
          }
          return TestLLM.text("done", "answer");
        });
        yield* remote.sessions.prompt({ sessionID: session.id, text: "remember this" });
        yield* remote.sessions.wait(session.id);
        expect(attempted).toBe(true);
        expect(JSON.stringify((yield* llm.requests()).at(-1)!.messages)).toContain(
          `Conversation ${name} failed`,
        );
        expect(
          yield* Effect.promise(() => readRuntime(session.location.directory)),
        ).toBeUndefined();
      }),
    ),
);

test("root-location sessions do not receive Conversation memory or dice", () =>
  withRemoteHost((remote, directory, { llm }) =>
    Effect.gen(function* () {
      const session = yield* remote.client.session.create({
        agent: Agent.ID.make("build"),
        model: Model.Ref.parse("test/probe"),
        location: { directory: AbsolutePath.make(directory) },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      });
      yield* llm.serve(() => TestLLM.text("done", "answer"));
      yield* remote.sessions.prompt({ sessionID: session.id, text: "roll once" });
      yield* remote.sessions.wait(session.id);
      const requests = yield* llm.requests();
      expect(requests.length).toBeGreaterThan(0);
      expect(
        requests.every((request) =>
          request.tools.every(
            (tool) => tool.name !== "dice" && !memoryToolNames.some((name) => name === tool.name),
          ),
        ),
      ).toBe(true);
      expect(yield* Effect.promise(() => readRuntime(directory))).toBeUndefined();
    }),
  ));
