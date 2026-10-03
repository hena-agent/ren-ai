import { afterEach, expect, test, vi } from "vitest";
import { character, fixture, generator, legacy, newToken, png, request } from "../test/fixtures.ts";
import { createAdmin } from "./admin.ts";
import { createProfileGenerator } from "./generation.ts";
import { loggedRequest, operation, protect, reportFailure, safeText } from "./logging.ts";
import type { LogEntry } from "./logging.ts";

afterEach(() => vi.restoreAllMocks());

test("input failures are warnings and uninstrumented unexpected failures are errors", async () => {
  const { admin, logs } = await fixture();
  const invalid = request("/personas", { ...character, draft: await newToken(admin) });
  invalid.headers.set("Origin", "https://other.test");
  const rejected = await admin(invalid);
  expect(rejected.status).toBe(400);
  expect(logs.find((entry) => entry.event === "operation.failed")).toMatchObject({
    stage: "request",
    level: "warn",
  });
  const broken = vi.spyOn(invalid.headers, "get").mockImplementation(() => {
    throw new Error("unexpected headers failure");
  });
  const failure = await admin(invalid);
  broken.mockRestore();
  expect(failure.status).toBe(503);
  expect(logs.at(-2)).toMatchObject({
    stage: "request",
    level: "error",
    error: { message: "unexpected headers failure" },
  });
  expect(logs.at(-1)).toMatchObject({ event: "request.completed", level: "error" });
});

test("raw generation errors redact every submitted private field, including seeds and signed drafts", async () => {
  let draft = "";
  const seed = "private idea";
  const { admin, logs } = await fixture({
    ...generator,
    character: async () => {
      throw new Error(
        `${seed} ${draft} ${character.name} ${character.description} Stryker was here!`,
      );
    },
  });
  draft = await newToken(admin);
  await admin(request("/personas", { ...character, seed, draft, intent: "character" }));
  const failure = logs.find((entry) => entry.event === "operation.failed")!;
  expect(failure).toMatchObject({ stage: "character.generate", level: "error" });
  for (const secret of [seed, draft, character.name, ...character.description.split("\n")])
    expect(failure.error?.message).not.toContain(secret);
  expect(failure.error?.message).toContain("Stryker was here!");
  const absent = await fixture({
    ...generator,
    introduction: async () => {
      throw new Error("Stryker was here!");
    },
  });
  await absent.admin(
    request("/personas", { ...character, draft: await newToken(absent.admin), intent: "generate" }),
  );
  expect(absent.logs.find((entry) => entry.event === "operation.failed")?.error?.message).toBe(
    "Stryker was here!",
  );
});

test("read and configuration diagnostics retain their operation and persona identity", async () => {
  const { admin, store, logs } = await fixture();
  await store.create(legacy);
  const image = await store.saveImage({ bytes: png, mimeType: "image/png" });
  await admin(request("/"));
  await admin(request("/personas/legacy"));
  await admin(request(image.replace("/discovery", "")));
  expect(logs).toContainEqual(
    expect.objectContaining({ stage: "persona.list", event: "operation.completed" }),
  );
  expect(logs).toContainEqual(
    expect.objectContaining({
      stage: "persona.get",
      personaId: "legacy",
      event: "operation.completed",
    }),
  );
  expect(logs).toContainEqual(
    expect.objectContaining({ stage: "image.read", event: "operation.completed" }),
  );
  const unconfigured = createAdmin(store, "test-password", "", {
    log: (entry) => logs.push(entry),
  });
  await unconfigured(
    request("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
  );
  expect(logs.find((entry) => entry.stage === "generation.configuration")?.error?.message).toBe(
    "Profile generator is not configured",
  );
});

test("request logs normalize private routes and classify response status boundaries", async () => {
  const routes: [string, string][] = [
    ["/", "/"],
    ["/new", "/new"],
    ["/personas", "/personas"],
    ["/api/personas", "/api/personas"],
    ["/personas/a_B-0", "/personas/:id"],
    ["/extra/personas/id", "/other"],
    ["/personas/id/secret", "/other"],
  ];
  for (const [path, route] of routes) {
    const logs: LogEntry[] = [];
    await loggedRequest(
      request(path),
      async () => new Response(),
      (entry) => logs.push(entry),
    );
    expect(logs.map(({ route: actual }) => actual)).toEqual([route, route]);
    expect(logs[0]).toMatchObject({ level: "info", event: "request.started" });
  }
  for (const [status, level] of [
    [200, "info"],
    [400, "warn"],
    [499, "warn"],
    [500, "error"],
    [599, "error"],
  ]) {
    const logs: LogEntry[] = [];
    await loggedRequest(
      request("/"),
      async () => new Response(null, { status: Number(status) }),
      (entry) => logs.push(entry),
    );
    expect(logs.at(-1)).toMatchObject({ level, status });
  }
});

test("operation and request durations measure elapsed time on both success and failure", async () => {
  let clock = 100;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const logs: LogEntry[] = [];
  await loggedRequest(
    request("/"),
    async () => {
      clock += 10;
      await operation("read", {}, async () => {
        clock += 25;
      });
      await expect(
        operation("write", {}, async () => {
          clock += 20;
          throw new Error("disk full");
        }),
      ).rejects.toThrow("disk full");
      return new Response(null, { status: 500 });
    },
    (entry) => logs.push(entry),
  );
  expect(logs.find((entry) => entry.event === "operation.completed")).toMatchObject({
    durationMs: 25,
  });
  expect(logs[1]).toMatchObject({ event: "operation.started", level: "info", stage: "read" });
  expect(logs.find((entry) => entry.event === "operation.failed")).toMatchObject({
    durationMs: 20,
  });
  expect(logs.at(-1)).toMatchObject({ durationMs: 55 });
});

test("diagnostics exclude payload-bearing stack lines and non-string error codes", async () => {
  const logs: LogEntry[] = [];
  await loggedRequest(
    request("/"),
    async () => {
      const error = Object.assign(new Error("failure"), { code: 42 });
      error.stack =
        "Error: payload\nprivate payload at nowhere\n    at first (a.ts:1:1)\n    at second (b.ts:2:2)";
      reportFailure(error, { stage: "read" });
      reportFailure(null, { stage: "nonerror" });
      const noStack = new Error("no stack");
      delete noStack.stack;
      reportFailure(noStack, { stage: "nostack" });
      expect(safeText("Stryker was here")).toBe("Stryker was here");
      protect("private");
      return new Response();
    },
    (entry) => logs.push(entry),
  );
  expect(logs.find((entry) => entry.stage === "read")?.error?.stack).toBe(
    "    at first (a.ts:1:1)\n    at second (b.ts:2:2)",
  );
  expect(logs.find((entry) => entry.stage === "read")).not.toHaveProperty("code");
  expect(logs.find((entry) => entry.stage === "nonerror")?.error?.message).toBe(
    "Non-Error failure",
  );
  expect(logs.find((entry) => entry.stage === "nostack")?.error?.stack).toBe("");
  expect(safeText("Stryker was here")).toBe("Stryker was here");
});

test("transport stack frames redact credentials registered by the generation adapter", async () => {
  const key = "private-secret";
  const error = new Error("offline");
  error.stack = `Error: ${key}\n    at transport (${key}:1:1)`;
  const provider = createProfileGenerator({
    key,
    fetcher: async () => {
      throw error;
    },
  });
  const { admin, logs } = await fixture({ ...provider, introduction: generator.introduction });
  await admin(
    request("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
  );
  const output = JSON.stringify(logs);
  expect(output).not.toContain(key);
  expect(output).toContain("transport (<REDACTED>:1:1)");
});

test("one shared cause is diagnosed once for each portrait operation without repeats at the request boundary", async () => {
  const logs: LogEntry[] = [];
  const error = new Error("shared provider outage");
  await loggedRequest(
    request("/personas"),
    async () => {
      for (const style of ["anime", "photo", "photo", "anime"]) {
        await expect(
          operation("portrait.generate", { style }, async () => {
            throw error;
          }),
        ).rejects.toBe(error);
      }
      reportFailure(error, { stage: "request" });
      return new Response(null, { status: 503 });
    },
    (entry) => logs.push(entry),
  );
  const failures = logs.filter((entry) => entry.event === "operation.failed");
  expect(failures.map(({ style }) => style)).toEqual(["anime", "photo"]);
});
