import { Plugin } from "@opencode/plugin/effect";
import { TestLLM } from "@opencode/ai/testing";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toolsPlugin } from "@ren-ai/plugin-tools";
import { contextPlugin } from "@ren-ai/plugin-context";
import { readSessionBinding } from "@ren-ai/plugin-session-folder/bindings";
import { remotePlugin } from "../../../../packages/plugins/application/src/runtime.ts";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";
import { captureDiagnostics } from "../../test/diagnostics.test-helper.ts";
import { allowAllSessionTools } from "../../test/server.test-helper.ts";

test("observer session lookup failures emit correlated payload-free diagnostics", () =>
  withRemoteHost((remote, directory, { registerPlugin }) =>
    Effect.gen(function* () {
      const captured = captureDiagnostics();
      const logs = () =>
        captured.logs
          .filter((entry) => entry.includes('"operation":"opencode.observation"'))
          .join("");
      yield* Effect.addFinalizer(() => Effect.sync(captured.restore));
      const observer = remotePlugin(
        "ren-ai.tools",
        () => Plugin.define({ id: "observer-noop", effect: () => Effect.void }),
        {
          directory,
          url: "https://unused.invalid/rpc",
          token: "private-token",
        },
      );
      yield* registerPlugin(
        Plugin.define({
          id: "observer-failure",
          effect: (ctx) =>
            observer.effect({
              ...ctx,
              session: {
                ...ctx.session,
                get: () =>
                  Effect.fail(
                    Object.assign(new Error("private title and schema payload"), {
                      code: "LOOKUP_FAILED",
                    }),
                  ),
              },
            }),
        }),
      );
      const session = yield* remote.createSession("persona1");
      yield* remote.sessions.prompt({ sessionID: session.id, text: "private conversation" });
      yield* remote.sessions.wait(session.id);
      yield* Effect.promise(async () => {
        await expect.poll(logs).toContain('"stage":"turn.session"');
      });
      expect(logs()).toContain('"code":"LOOKUP_FAILED"');
      expect(logs()).toMatch(/"requestId":"[0-9a-f-]{36}"/);
      expect(logs()).not.toContain("private");
    }),
  ));

test.each(["missing", "read-only"] as const)(
  "a native wait rechecks a %s binding after the model chose the tool",
  (mode) =>
    withRemoteHost((remote, directory, { llm, registerPlugin }) =>
      Effect.gen(function* () {
        const captured = captureDiagnostics();
        yield* Effect.addFinalizer(() => Effect.sync(captured.restore));
        let invoked = false;
        yield* registerPlugin(
          remotePlugin(
            "ren-ai.context",
            ({ context: _context, ...options }) => contextPlugin(options),
            { directory, url: "https://unused.invalid/rpc", token: "PRIVATE_WAIT_TOKEN" },
          ),
        );
        yield* registerPlugin(
          remotePlugin(
            "wait-binding-probe",
            (options) =>
              Plugin.define({
                id: "wait-binding-race",
                effect: (ctx) =>
                  Effect.gen(function* () {
                    yield* ctx.tool.transform((editor) => {
                      for (const name of ["send", "wait", "read", "react", "end_conversation"])
                        editor.remove(name);
                    });
                    yield* toolsPlugin(options).effect(ctx);
                    yield* ctx.tool.transform((editor) =>
                      editor.update("wait", (tool) => {
                        const execute = tool.execute;
                        tool.execute = (input, context) =>
                          Effect.gen(function* () {
                            invoked = true;
                            const path = join(
                              ctx.location.directory,
                              ".sessions",
                              `${context.sessionID}.json`,
                            );
                            const original = yield* Effect.promise(() => readFile(path, "utf8"));
                            const binding = yield* Effect.promise(() =>
                              readSessionBinding(ctx.location.directory, context.sessionID),
                            );
                            yield* Effect.promise(() =>
                              mode === "missing"
                                ? rm(path)
                                : writeFile(path, JSON.stringify({ ...binding, writable: false })),
                            );
                            return yield* execute(input, context).pipe(
                              Effect.ensuring(Effect.promise(() => writeFile(path, original))),
                            );
                          });
                      }),
                    );
                  }),
              }),
            { directory, url: "https://unused.invalid/rpc", token: "PRIVATE_WAIT_TOKEN" },
          ),
        );
        const session = yield* remote.createSession("persona1");
        yield* allowAllSessionTools(remote, session.id);
        let requested = false;
        yield* llm.serve((request) => {
          if (!requested && request.tools.some((tool) => tool.name === "wait")) {
            requested = true;
            return TestLLM.tool("stale-wait", "wait", { seconds: 120 });
          }
          return TestLLM.text("finished without waiting", "answer");
        });
        yield* remote.sessions.prompt({ sessionID: session.id, text: "PRIVATE_WAIT_CONVERSATION" });
        yield* remote.sessions.wait(session.id).pipe(Effect.timeout("5 seconds"));
        expect(invoked).toBe(true);
        const results = (yield* llm.requests())
          .flatMap((request) => request.messages)
          .flatMap((message) => message.content)
          .filter((part) => part.type === "tool-result" && part.id === "stale-wait");
        expect(results).toHaveLength(1);
        expect(JSON.stringify(results)).toContain(
          mode === "missing"
            ? "ENOENT"
            : "This session is read-only. Finish this turn without waiting.",
        );
        expect(JSON.stringify(results)).not.toContain("paused");
        expect(captured.logs.join("")).not.toContain("PRIVATE_WAIT_");
        expect((yield* remote.sessions.get(session.id)).outcome).toBe("succeeded");
      }),
    ),
);
