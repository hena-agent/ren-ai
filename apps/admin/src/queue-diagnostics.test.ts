import { expect, test, vi } from "vitest";
import { createProfileGenerator } from "./generation.ts";
import { loggedRequest, reportQueueCompleted } from "./logging.ts";
import type { LogEntry } from "./logging.ts";
import {
  character,
  fixture,
  generator,
  newToken,
  portraitReply,
  request,
  tokenOf,
} from "../test/fixtures.ts";
import { savedPreview, subGenerator } from "../test/sub-portraits.ts";
import { queuedRequest, jobUrl, finishedJob } from "../test/queue.ts";

test("provider lifecycle diagnostics include their own model and style even without a parent image-task context", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(portraitReply);
  const generator = createProfileGenerator({
    key: "private key",
    imageModel: "image-model",
    textModel: "text-model",
    fetcher,
  });
  const logs: LogEntry[] = [];
  await loggedRequest(
    request("/personas", { intent: "generate" }),
    async () => {
      await generator.portrait(character, "photo");
      return new Response();
    },
    (entry) => logs.push(entry),
  );
  expect(
    logs.find((entry) => entry.stage === "generation.api" && entry.event === "operation.started"),
  ).toMatchObject({ model: "image-model", style: "photo" });
  fetcher.mockResolvedValueOnce(
    Response.json({ candidates: [{ content: { parts: [{ text: "A public introduction." }] } }] }),
  );
  await loggedRequest(
    request("/personas", { intent: "introduction" }),
    async () => {
      await generator.introduction(character);
      return new Response();
    },
    (entry) => logs.push(entry),
  );
  const text = logs.find(
    (entry) => entry.stage === "generation.api" && entry.model === "text-model",
  )!;
  expect(text).not.toHaveProperty("style");
  expect(JSON.stringify(logs)).not.toContain("private key");
});

test("failure diagnostics redact a repeated second-photo prompt echoed by the image provider", async () => {
  const portrait = vi
    .fn<typeof generator.portrait>()
    .mockImplementation(async (_character, _style, prompt) => {
      throw Object.assign(new Error(`upstream echoed ${prompt}`), { code: "E_PROVIDER_ECHO" });
    });
  const { admin, logs } = await fixture({ ...subGenerator, portrait });
  const accepted = await admin(
    queuedRequest(
      "/personas",
      {
        ...character,
        draft: await newToken(admin),
        intent: "generate",
      },
      ["first-private-direction", "repeated-second-private-direction"],
    ),
  );
  await finishedJob(admin, jobUrl(accepted));
  const failures = logs.filter((entry) => entry.event === "operation.failed");
  expect(failures).toHaveLength(2);
  expect(failures.every((entry) => entry.code === "E_PROVIDER_ECHO")).toBe(true);
  expect(JSON.stringify(logs)).not.toContain("repeated-second-private-direction");
  expect(JSON.stringify(logs)).not.toContain("first-private-direction");
});

test("queue summaries classify exact success, input and unexpected status boundaries with correlated lifecycle metadata", async () => {
  const logs: LogEntry[] = [];
  for (const status of [200, 400, 500]) {
    await loggedRequest(
      request("/image-jobs/example"),
      async () => {
        reportQueueCompleted({
          jobId: "job",
          status,
          outcome: status === 200 ? "completed" : "failed",
          durationMs: 30,
        });
        return new Response();
      },
      (entry) => logs.push(entry),
    );
  }
  const summaries = logs.filter((entry) => entry.event === "image.queue.completed");
  expect(
    summaries.map((entry) => [entry.stage, entry.level, entry.status, entry.durationMs]),
  ).toEqual([
    ["image.queue", "info", 200, 30],
    ["image.queue", "warn", 400, 30],
    ["image.queue", "error", 500, 30],
  ]);
  expect(summaries.every((entry) => Boolean(entry.requestId))).toBe(true);
});

test("text-only edits keep the latest unsaved images on reload and configuration errors retain every separate input", async () => {
  const introduction = vi
    .fn<typeof subGenerator.introduction>()
    .mockImplementationOnce(subGenerator.introduction)
    .mockResolvedValue("Changed introduction for recovery.");
  const { admin, route, editing, logs } = await savedPreview({ ...subGenerator, introduction });
  const images = await admin(
    queuedRequest(`${route}?style=photo`, {
      ...character,
      draft: tokenOf(editing),
      intent: "subportrait",
    }),
  );
  const latest = await finishedJob(admin, jobUrl(images));
  const response = await admin(
    request(route, { ...character, draft: tokenOf(latest), intent: "introduction" }),
  );
  expect(response.status).toBe(200);
  expect(
    logs.find(
      (entry) =>
        entry.requestId === response.headers.get("x-request-id") &&
        entry.event === "operation.completed",
    )?.stage,
  ).toBe("introduction.generate");
  expect(await (await admin(request(route))).text()).toContain(
    "Changed introduction for recovery.",
  );
  const missing = await fixture();
  const { createAdmin } = await import("./admin.ts");
  const unavailable = createAdmin(missing.store, "test-password", "", { log: () => {} });
  const failed = await unavailable(
    queuedRequest(
      "/personas",
      { ...character, draft: await newToken(unavailable), intent: "generate", imageCount: "1" },
      ["anime input", "photo input"],
    ),
  );
  expect(failed.status).toBe(503);
  const page = await failed.text();
  expect(page).toContain("anime input");
  expect(page).toContain("photo input");
});

test("a retry request redacts its signed draft and every private source field before provider failure handling", async () => {
  let signed = "";
  const model = {
    ...subGenerator,
    portrait: vi.fn<typeof subGenerator.portrait>().mockImplementation(subGenerator.portrait),
  };
  const { admin, editing, route, logs } = await savedPreview(model);
  model.portrait.mockRejectedValueOnce(new Error("second failed"));
  const accepted = await admin(
    queuedRequest(`${route}?style=photo`, {
      ...character,
      draft: tokenOf(editing),
      intent: "subportrait",
    }),
  );
  expect(accepted.status).toBe(303);
  const path = jobUrl(accepted);
  const partial = await finishedJob(admin, path);
  signed = tokenOf(partial);
  model.portrait.mockRejectedValueOnce(
    new Error(`${character.name}\n${character.description}\nprivate retry\n${signed}`),
  );
  const retry = await admin(
    queuedRequest(`${path}/retry?image=0`, {
      ...character,
      draft: signed,
      portraitInstructions: "  private retry  ",
    }),
  );
  expect(retry.status).toBe(303);
  await finishedJob(admin, path);
  const failures = logs.filter(
    (entry) =>
      entry.event === "operation.failed" && entry.requestId === retry.headers.get("x-request-id"),
  );
  expect(failures).toHaveLength(1);
  for (const value of [signed, character.name, character.description, "private retry"])
    expect(failures[0]?.error?.message).not.toContain(value);
  expect(failures[0]?.error?.message).not.toContain(signed.slice(0, 80));
});
