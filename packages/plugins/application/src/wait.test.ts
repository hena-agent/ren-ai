import { Effect, Stream } from "effect";
import { expect, test, vi } from "vitest";
import { waitForResult, type WaitClient } from "./wait.ts";

test("wait keeps its final non-heartbeat result unchanged", async () => {
  const wait = vi.fn<WaitClient["wait"]>(() => Stream.make("", "first", "", "last"));
  await expect(Effect.runPromise(waitForResult({ wait }, "session", 5))).resolves.toBe("last");
  expect(wait).toHaveBeenCalledOnce();
  expect(wait).toHaveBeenCalledWith({ sessionID: "session", seconds: 5 });
});

test("wait retries a transport error and an empty EOF with a bounded backoff and remaining deadline", async () => {
  const wait = vi
    .fn<WaitClient["wait"]>()
    .mockReturnValueOnce(Stream.fail(new Error("socket closed")))
    .mockReturnValueOnce(Stream.empty)
    .mockReturnValueOnce(Stream.make("resumed"));
  const started = Date.now();
  await expect(Effect.runPromise(waitForResult({ wait }, "session", 5))).resolves.toBe("resumed");
  expect(wait).toHaveBeenCalledTimes(3);
  expect(wait.mock.calls[0]?.[0].seconds).toBe(5);
  expect(wait.mock.calls[1]?.[0].seconds).toBeLessThan(5);
  expect(Date.now() - started).toBeGreaterThanOrEqual(400);
});

test("application rejection is not retried", async () => {
  const wait = vi.fn<WaitClient["wait"]>(() => Stream.fail("wait rejected by application"));
  await expect(Effect.runPromise(waitForResult({ wait }, "session", 5))).rejects.toThrow(
    "wait rejected by application",
  );
  expect(wait).toHaveBeenCalledOnce();
});

test("wait does not retry after its deadline expires", async () => {
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValueOnce(1000)
    .mockReturnValueOnce(1000)
    .mockReturnValue(1010);
  const wait = vi.fn<WaitClient["wait"]>(() => Stream.fail(new Error("socket closed")));
  try {
    await expect(Effect.runPromise(waitForResult({ wait }, "session", 0.01))).rejects.toThrow(
      "Wait stream ended without a result",
    );
    expect(wait).toHaveBeenCalledOnce();
  } finally {
    clock.mockRestore();
  }
});

test("an EOF arriving after the deadline does not open another wait request", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValue(2000);
  const wait = vi.fn<WaitClient["wait"]>(() => Stream.empty);
  try {
    await expect(Effect.runPromise(waitForResult({ wait }, "session", 0.5))).rejects.toThrow(
      "Wait stream ended without a result",
    );
    expect(wait).toHaveBeenCalledOnce();
  } finally {
    clock.mockRestore();
  }
});
