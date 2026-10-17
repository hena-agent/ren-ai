import { Effect, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect, test, vi } from "vitest";
import { observeTurns } from "./observe.ts";

test("terminal hints recover after subscription failure and diagnose rejected deliveries without private payloads", async () => {
  const logs: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    logs.push(String(chunk));
    return true;
  });
  const delivered: string[] = [];
  const failures = [
    "private payload",
    new Error("private text"),
    Object.assign(new Error("private text"), { code: 503 }),
    Object.assign(new Error("private text"), { code: "private-code" }),
    Object.assign(new Error("private text"), { name: "private-name", code: "UPSTREAM_DOWN" }),
    new Error("private text", {
      cause: Object.assign(new TypeError("private cause"), { code: "IO_DOWN" }),
    }),
  ];
  let subscriptions = 0;
  const events = Stream.suspend(() =>
    subscriptions++ === 0
      ? Stream.fail(new Error("private subscription"))
      : Stream.concat(
          Stream.fromIterable([
            { type: "unrelated" },
            { type: "session.inbox.enqueued", data: { sessionID: "ignored" } },
            ...failures.map((_, index) => ({
              type: "session.execution.failed",
              data: { sessionID: String(index) },
            })),
            { type: "session.execution.succeeded", data: { sessionID: "success" } },
          ]),
          Stream.never,
        ),
  );
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* observeTurns(events, (id) => {
            delivered.push(id);
            const failure = failures[Number(id)];
            return failure ? Effect.fail(failure) : Effect.void;
          });
          yield* Effect.yieldNow;
          expect(logs).toHaveLength(1);
          yield* TestClock.adjust("1 second");
          expect(delivered).toEqual(["0", "1", "2", "3", "4", "5", "success"]);
          expect(logs).toHaveLength(7);
          expect(logs.join("")).toContain('"stage":"turn.subscribe"');
          expect(logs.join("")).toContain('"stage":"turn.delivery"');
          expect(logs.join("")).toContain('"code":"IO_DOWN"');
          expect(logs.join("")).toContain('"code":"UPSTREAM_DOWN"');
          expect(logs.join("")).not.toContain("private");
          for (const entry of logs) expect(entry).toMatch(/"requestId":"[0-9a-f-]{36}"/);
        }).pipe(Effect.provide(TestClock.layer())),
      ),
    );
  } finally {
    stderr.mockRestore();
  }
});
