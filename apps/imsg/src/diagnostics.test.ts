import { Effect, Logger } from "effect";
import { expect, test } from "vitest";
import { observe } from "./diagnostics.ts";

const capture = async (error: Error) => {
  const logs: string[] = [];
  await Effect.runPromise(
    observe("rustpush.event.apply", Effect.fail(error), () => ({})).pipe(
      Effect.ignore,
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
  const log = await capture(new Error("private message", { cause }));
  expect(log).toContain('"code":28');
  expect(log).toContain('"causeName":"Error"');
  expect(log).toContain('"outcome":"failed"');
  expect(log).toContain('"stack":');
});

test.each([true, "private credential echoed by upstream"])(
  "diagnostics omit untrusted non-code values: %j",
  async (code) => {
    const log = await capture(
      Object.assign(new Error("private message"), { code, stage: "private input" }),
    );
    expect(log).not.toContain('"code":');
    expect(log).not.toContain('"causeStage":');
  },
);
