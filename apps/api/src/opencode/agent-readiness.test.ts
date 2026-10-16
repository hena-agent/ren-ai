import { Agent, AbsolutePath } from "@opencode/schema";
import { Effect, Fiber, Exit } from "effect";
import type { OpenCode } from "@opencode/client/effect";
import { TestClock } from "effect/testing";
import { expect, test, vi } from "vitest";
import { awaitPersonaAgent } from "./agent-readiness.ts";

test("readiness waits through absent agents, missing instructions and stale definitions before acknowledging current content", async () => {
  const definition = Agent.Info.default(Agent.ID.make("persona1"));
  const location = { directory: AbsolutePath.make("/session") };
  let calls = 0;
  const list = vi.fn<Effect.Success<ReturnType<typeof OpenCode.make>>["agent"]["list"]>(() =>
    Effect.sync(() => {
      calls++;
      if (calls === 1) return { location, data: [] };
      if (calls === 2) return { location, data: [definition] };
      return {
        location,
        data: [{ ...definition, system: calls === 3 ? "old version" : "current definition\n" }],
      };
    }),
  );
  await Effect.runPromise(
    awaitPersonaAgent({ list }, "/session", { id: "persona1", prompt: "current definition" }),
  );
  expect(list).toHaveBeenCalledWith({ location: { directory: "/session" } });
  expect(calls).toBe(4);
});

test("an agent that never loads the current definition fails within the bounded readiness window", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const waiting = yield* Effect.forkScoped(
          Effect.exit(
            awaitPersonaAgent(
              {
                list: () =>
                  Effect.succeed({
                    location: { directory: AbsolutePath.make("/session") },
                    data: [],
                  }),
              },
              "/session",
              {
                id: "persona1",
                prompt: "current",
              },
            ),
          ),
        );
        yield* TestClock.adjust("5 seconds");
        expect(Exit.isFailure(yield* Fiber.join(waiting))).toBe(true);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
});
