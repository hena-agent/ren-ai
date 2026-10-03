import { afterEach, expect, test, vi } from "vitest";
import { character, fixture, generator, newToken, request } from "../test/fixtures.ts";
import copy from "./copy.json";
import { createAdmin } from "./admin.ts";
import { rm } from "node:fs/promises";
import {
  GenerationError,
  loggedRequest,
  operation,
  protect,
  reportFailure,
  requestFields,
  safeText,
} from "./logging.ts";
import type { LogEntry } from "./logging.ts";
import { createProfileGenerator } from "./generation.ts";
import { introduction, png, tokenOf } from "../test/fixtures.ts";

afterEach(() => vi.restoreAllMocks());

test("a failed portrait request preserves the editor and writes a correlated diagnostic to stderr", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const { store } = await fixture();
  const admin = createAdmin(store, "test-password", "", {
    generator: {
      ...generator,
      portrait: async () => {
        throw new Error("upstream offline");
      },
    },
  });
  const draft = await newToken(admin);
  stderr.mockClear();
  const response = await admin(request("/personas", { ...character, draft, intent: "generate" }));
  const page = await response.text();
  expect(response.status).toBe(503);
  expect(page).toContain(copy.failure);
  expect(page).toContain(character.name);
  expect(page).not.toContain("upstream offline");
  expect(stderr).toHaveBeenCalled();
  const output = stderr.mock.calls.map(([line]) => String(line)).join("");
  expect(output).toContain("upstream offline");
  const id = response.headers.get("x-request-id");
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(output).toContain(id);
  expect(page).toContain(`요청 ID: ${id}`);
  expect(output).not.toContain(character.description);
  expect(output).not.toContain(draft);
});

test("successful generation, saving and reads emit timed lifecycle events with stable request context", async () => {
  const { admin, logs } = await fixture();
  const draft = await newToken(admin);
  logs.length = 0;
  const response = await admin(request("/personas", { ...character, draft, intent: "generate" }));
  const id = response.headers.get("x-request-id");
  expect(logs[0]).toMatchObject({
    event: "request.started",
    method: "POST",
    route: "/personas",
    requestId: id,
  });
  expect(logs.at(-1)).toMatchObject({
    event: "request.completed",
    status: 200,
    level: "info",
    requestId: id,
  });
  const completed = logs.filter((entry) => entry.event === "operation.completed");
  expect(completed.map(({ stage, style }) => [stage, style])).toEqual([
    ["introduction.generate", undefined],
    ["portrait.generate", "anime"],
    ["portrait.generate", "photo"],
    ["image.save", expect.stringMatching(/anime|photo/)],
    ["image.save", expect.stringMatching(/anime|photo/)],
  ]);
  for (const entry of logs.slice(1)) {
    expect(entry).toMatchObject({
      service: "admin",
      requestId: id,
      intent: "generate",
    });
    expect(entry.time).toMatch(/^\d{4}-/);
    expect(entry.personaId).toMatch(/^[0-9a-f-]{36}$/);
  }
  for (const entry of [...completed, logs.at(-1)!])
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  const saved = await admin(
    request("/personas", { ...character, draft: tokenOf(await response.text()) }),
  );
  expect(saved.status).toBe(303);
  expect(logs).toContainEqual(
    expect.objectContaining({
      stage: "persona.save",
      event: "operation.completed",
      intent: "save",
    }),
  );
});

test("parallel portrait failures remain visible after the response and concurrent requests keep separate IDs", async () => {
  let rejectPhoto = vi.fn<(error: Error) => void>();
  const photo = new Promise<typeof png>((_resolve, reject) => {
    rejectPhoto = vi.fn<(error: Error) => void>(reject);
  });
  const { admin, logs } = await fixture({
    ...generator,
    portrait: async (_character, style) => {
      if (style === "anime") throw new Error("anime offline");
      await photo;
      return { bytes: png, mimeType: "image/png" };
    },
  });
  const draft = await newToken(admin);
  const failed = await admin(request("/personas", { ...character, draft, intent: "generate" }));
  const other = await admin(request("/"));
  expect(other.headers.get("x-request-id")).not.toBe(failed.headers.get("x-request-id"));
  rejectPhoto(new Error("photo offline"));
  await photo.catch(() => {});
  await Promise.resolve();
  const failures = logs.filter((entry) => entry.event === "operation.failed");
  expect(failures).toHaveLength(2);
  expect(failures.map(({ style }) => style)).toEqual(["anime", "photo"]);
  for (const entry of failures)
    expect(entry).toMatchObject({
      requestId: failed.headers.get("x-request-id"),
      stage: "portrait.generate",
      level: "error",
    });
});

test("Gemini HTTP failures identify the model and style while removing echoed secrets and private inputs", async () => {
  const key = "private-api-key";
  const provider = createProfileGenerator({
    key,
    imageModel: "image-model",
    fetcher: async () =>
      Response.json(
        {
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message: `Quota exceeded ${key} ${character.name}\n${character.description}`,
          },
        },
        { status: 429 },
      ),
  });
  const { admin, logs } = await fixture({ ...provider, introduction: generator.introduction });
  const draft = await newToken(admin);
  const response = await admin(request("/personas", { ...character, draft, intent: "generate" }));
  const failures = logs.filter((entry) => entry.event === "operation.failed");
  expect(failures).toHaveLength(2);
  for (const entry of failures)
    expect(entry).toMatchObject({
      stage: "generation.api",
      model: "image-model",
      status: 429,
      code: "429",
      providerStatus: "RESOURCE_EXHAUSTED",
      error: { name: "GenerationError" },
    });
  for (const entry of failures) expect(entry.error?.message).toContain("Quota exceeded");
  expect(failures.map(({ style }) => style)).toEqual(["anime", "photo"]);
  const output = JSON.stringify(logs);
  for (const secret of [
    key,
    character.name,
    ...character.description.split("\n"),
    draft,
    "x-goog-api-key",
    png.toString("base64"),
  ])
    expect(output).not.toContain(secret);
  expect(output).toContain("<REDACTED>");
  expect(await response.text()).not.toContain("Quota exceeded");
});

test("storage failures expose the underlying filesystem code and missing generation configuration is logged", async () => {
  const { admin, store, logs, root } = await fixture();
  const missing: LogEntry[] = [];
  const unconfigured = createAdmin(store, "test-password", "", {
    log: (entry) => missing.push(entry),
  });
  const draft = await newToken(admin);
  const failure = await unconfigured(
    request("/personas", { ...character, draft, intent: "generate" }),
  );
  expect(missing).toContainEqual(
    expect.objectContaining({ stage: "generation.configuration", level: "error" }),
  );
  expect(await failure.text()).toContain(`요청 ID: ${failure.headers.get("x-request-id")}`);
  await rm(root, { recursive: true });
  const response = await admin(request("/api/personas"));
  expect(response.status).toBe(503);
  expect(logs).toContainEqual(
    expect.objectContaining({
      stage: "persona.publicList",
      code: "ENOENT",
    }),
  );
  expect(logs.find((entry) => entry.code === "ENOENT")?.error?.message).toContain("ENOENT");
});

test("image persistence failures are distinct from successful model generation", async () => {
  const { admin, store, logs } = await fixture();
  vi.spyOn(store, "saveImage").mockRejectedValue(
    Object.assign(new Error("disk full"), { code: "ENOSPC" }),
  );
  const response = await admin(
    request("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
  );
  expect(response.status).toBe(503);
  const failures = logs.filter((entry) => entry.event === "operation.failed");
  expect(failures).toHaveLength(2);
  for (const entry of failures)
    expect(entry).toMatchObject({ stage: "image.save", code: "ENOSPC" });
});

test("diagnostics bound messages, preserve safe call sites and handle untyped exceptions", async () => {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  protect("outside request");
  requestFields({ intent: "outside" });
  expect(safeText("unchanged")).toBe("unchanged");
  expect(safeText("abcabcd", ["", "abc", "abcd"])).toBe("<REDACTED><REDACTED>");
  expect(safeText("x".repeat(1001))).toHaveLength(1000);
  reportFailure("not an error", { stage: "standalone" });
  const noStack = new Error("message");
  delete noStack.stack;
  reportFailure(Object.assign(noStack, { code: 42 }), { stage: "standalone" });
  expect(stderr.mock.calls.map(([line]) => String(line)).join("")).toContain('"stack":""');
  const entries: LogEntry[] = [];
  const response = await loggedRequest(
    request("/unknown?key=private"),
    async () => {
      protect("sensitive", "");
      requestFields({ intent: "probe" });
      const error = new GenerationError("sensitive " + "x".repeat(1001), { code: "probe" });
      error.stack = "Error: private payload\n  private payload\n    at sensitive (module.ts:1:1)";
      reportFailure(error, { stage: "probe" });
      reportFailure(error, { stage: "probe" });
      await expect(
        operation("throw", {}, async () => {
          throw undefined;
        }),
      ).rejects.toBeUndefined();
      await operation("ok", {}, async () => "result");
      return new Response(null, { status: 400 });
    },
    (entry) => entries.push(entry),
  );
  expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  const failure = entries.find((entry) => entry.code === "probe")!;
  expect(failure.error).toEqual({
    name: "GenerationError",
    message: "<REDACTED> " + "x".repeat(989),
    stack: "    at <REDACTED> (module.ts:1:1)",
  });
  expect(entries.filter((entry) => entry.code === "probe")).toHaveLength(1);
  expect(entries.at(-1)).toMatchObject({ route: "/other", level: "warn", status: 400 });
  expect(stdout).not.toHaveBeenCalled();
  await operation("outside", {}, async () => introduction);
  expect(stdout).toHaveBeenCalledTimes(2);
});
