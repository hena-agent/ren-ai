// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";
import { serverCause, writeServerLog } from "./server-log.ts";

afterEach(() => vi.restoreAllMocks());

test("server diagnostics preserve safe causes and write structured JSON to the matching sink", () => {
  const info = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const error = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const event = {
    requestId: "request",
    operation: "discovery.public" as const,
    stage: "request",
    outcome: "completed" as const,
    durationMs: 1,
  };
  writeServerLog({ ...event, level: "info" });
  writeServerLog({ ...event, level: "warn" });
  expect(info).toHaveBeenCalledWith(expect.stringContaining('"service":"discovery"'));
  expect(error).toHaveBeenCalledWith(expect.stringContaining('"level":"warn"'));
  const cause = Object.assign(new TypeError("private"), {
    code: "ETIMEDOUT",
    stack: "TypeError: private\n at call (server.ts:1:1)",
  });
  expect(serverCause(new Error("wrapper", { cause }))).toEqual({
    causeName: "TypeError",
    causeCode: "ETIMEDOUT",
    stack: " at call (server.ts:1:1)",
  });
  expect(serverCause({ private: "payload" })).toMatchObject({ causeName: "Error" });
  expect(
    serverCause(
      Object.assign(new Error("private"), { code: "private input with spaces", stack: undefined }),
    ),
  ).toEqual({ causeName: "Error", stack: "" });
  expect(serverCause(Object.assign(new Error("private"), { code: 42 }))).toHaveProperty(
    "causeCode",
    "42",
  );
  expect(serverCause(Object.assign(new Error("private"), { code: Number.NaN }))).not.toHaveProperty(
    "causeCode",
  );
});
