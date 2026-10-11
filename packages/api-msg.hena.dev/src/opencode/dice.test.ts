import { TestLLM } from "@opencode/ai/testing";
import { Plugin } from "@opencode/plugin/effect";
import { isDiceTool } from "@ren-ai/plugin-dice";
import { Effect, Schema } from "effect";
import { expect, test, vi } from "vitest";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";

test("agents can call dice without arguments and receive a fresh inclusive 0–10000 integer", () =>
  withRemoteHost((remote, _directory, { llm }) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      const random = vi.spyOn(Math, "random");
      const samples = [0, 0.5, 1 - Number.EPSILON];
      let rolls = 0;
      try {
        yield* llm.serve((request) => {
          if (!request.tools.some((tool) => tool.name === "dice"))
            return TestLLM.text("no dice", "answer");
          if (rolls === samples.length) return TestLLM.text("done", "answer");
          random.mockReturnValue(samples[rolls]!);
          return TestLLM.tool(`roll-${rolls++}`, "dice", {});
        });
        expect(rolls).toBe(0);
        yield* remote.sessions.prompt({ sessionID: session.id, text: "Choose using dice." });
        yield* remote.sessions.wait(session.id);
        expect(rolls).toBe(3);
        const requests = yield* llm.requests();
        const tool = requests
          .flatMap((request) => request.tools)
          .find((entry) => entry.name === "dice")!;
        if (!("inputSchema" in tool)) throw new Error("dice must be a callable tool");
        expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
        expect(isDiceTool({ description: tool.description, input: tool.inputSchema })).toBe(true);
        expect(isDiceTool(undefined)).toBe(false);
        expect(isDiceTool({ description: "Another tool", input: tool.inputSchema })).toBe(false);
        expect(isDiceTool({ description: tool.description, input: { type: "string" } })).toBe(
          false,
        );
        const results = requests
          .at(-1)!
          .messages.flatMap((message) => message.content)
          .filter((part) => part.type === "tool-result")
          .filter((part) => part.name === "dice")
          .map((part) => part.result);
        expect(results).toEqual([
          { type: "text", value: "0" },
          { type: "text", value: "5000" },
          { type: "text", value: "10000" },
        ]);
      } finally {
        random.mockRestore();
      }
    }),
  ));

test.each(["absent", "wrong-schema"])("agents do not receive an %s dice tool", (mode) =>
  withRemoteHost((remote, _directory, { llm, registerPlugin }) =>
    Effect.gen(function* () {
      yield* registerPlugin(
        Plugin.define({
          id: "dice-unavailable",
          effect: (ctx) =>
            ctx.tool
              .transform((editor) => {
                if (mode === "absent") editor.remove("dice");
                else
                  editor.update("dice", (tool) => {
                    tool.input = Schema.String;
                  });
              })
              .pipe(Effect.asVoid),
        }),
      );
      const session = yield* remote.createSession("persona1");
      yield* remote.sessions.prompt({ sessionID: session.id, text: "Choose freely." });
      yield* remote.sessions.wait(session.id);
      const requests = yield* llm.requests();
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((request) => request.tools.every((tool) => tool.name !== "dice"))).toBe(
        true,
      );
    }),
  ),
);
