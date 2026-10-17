import { Effect, Logger } from "effect";
import { expect, test } from "vitest";
import { observe } from "./diagnostics.ts";

const capture = async (body: Effect.Effect<void, Error>) => {
  const logs: string[] = [];
  await Effect.runPromise(
    observe("rustpush.event.apply", body, () => ({})).pipe(
      Effect.exit,
      Effect.provide(
        Logger.layer([
          Logger.make((entry) => {
            logs.push(JSON.stringify(entry.message));
          }),
        ]),
      ),
    ),
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]).not.toContain("private");
  return logs[0]!;
};

test("diagnostics retain wrapped I/O codes without echoing payload-bearing errors", async () => {
  const cause = Object.assign(new Error("private credential and path"), { code: 28 });
  const log = await capture(Effect.fail(new Error("private message", { cause })));
  expect(log).toContain('"code":28');
  expect(log).toContain('"causeName":"Error"');
  expect(log).toContain('"outcome":"failed"');
  expect(log).toContain('"stack":');
});

test.each([true, "private credential echoed by upstream"])(
  "diagnostics omit untrusted non-code values: %j",
  async (code) => {
    const log = await capture(
      Effect.fail(Object.assign(new Error("private message"), { code, stage: "private input" })),
    );
    expect(log).not.toContain('"code":');
    expect(log).not.toContain('"causeStage":');
  },
);

test("background interruption is diagnosed without pretending the operation completed", async () => {
  const log = await capture(Effect.interrupt);
  expect(log).toContain('"causeName":"InterruptedOrDefect"');
  expect(log).toContain('"outcome":"failed"');
  expect(log).toMatch(/"requestId":"[0-9a-f-]{36}"/);
});
