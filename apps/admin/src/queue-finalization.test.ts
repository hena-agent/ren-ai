import { afterEach, expect, test, vi } from "vitest";
import { serializePersona } from "@ren-ai/personas";
import { createImageQueue } from "./image-queue.ts";
import { createImageBatch } from "./image-batch.ts";
import { loggedRequest, requestFields } from "./logging.ts";
import type { LogEntry, Log } from "./logging.ts";
import { savedPreview, subGenerator } from "../test/sub-portraits.ts";
import { request } from "../test/fixtures.ts";
import copy from "./copy.json";
import type { Draft } from "./draft.ts";
import { portraitImage } from "../test/fixtures.ts";

afterEach(() => vi.restoreAllMocks());

async function enqueueBoundary(
  queue: ReturnType<typeof createImageQueue>,
  key: string,
  setup: Awaited<ReturnType<typeof savedPreview>>,
  log: Log,
) {
  const { original, store } = setup;
  const batch = createImageBatch(
    original,
    {
      id: original.id,
      base: serializePersona(original),
      preview: serializePersona(original),
      imageCount: 1,
      imageInstructions: "",
    },
    "subportrait",
    new URLSearchParams({ style: "photo" }),
    "subportrait:photo",
    subGenerator,
    store,
  );
  let id = "";
  await loggedRequest(
    request("/personas", { intent: "subportrait" }),
    async () => {
      requestFields({ personaId: original.id });
      id = queue.enqueue(key, batch).id;
      return new Response(null, { status: 202 });
    },
    log,
  );
  return queue.get(id);
}

test("an unexpected preview-update failure is observed, releases the persona lock and leaves the next FIFO job runnable", async () => {
  const setup = await savedPreview();
  const { original } = setup;
  const error = Object.assign(new Error("preview synchronization failed"), {
    code: "E_PREVIEW_SYNC",
  });
  let fail = true;
  const update = vi.fn<Parameters<typeof createImageQueue>[0]>().mockImplementation(() => {
    if (fail) throw error;
  });
  const queue = createImageQueue(update, () => undefined);
  const logs: LogEntry[] = [];
  const enqueue = (key: string) => enqueueBoundary(queue, key, setup, (entry) => logs.push(entry));
  const first = await enqueue("first");
  expect(() => queue.retryFailed(first.id, first.batch.draft())).toThrow(
    expect.objectContaining({ kind: "conflict", message: copy.busy }),
  );
  await queue.wait(first);
  expect(first.state).toBe("failed");
  expect(first.tasks[0]?.state).toBe("completed");
  expect(queue.pending(original.id)).toBeUndefined();
  expect(logs.filter((entry) => entry.event === "operation.failed")).toHaveLength(1);
  expect(logs.find((entry) => entry.event === "operation.failed")?.code).toBe("E_PREVIEW_SYNC");
  fail = false;
  const next = await enqueue("next");
  await queue.wait(next);
  expect(next.state).toBe("completed");
  expect(queue.pending(original.id)).toBeUndefined();
  expect(next.tasks[0]?.imageUrl).toBeTruthy();
});

test("non-Error finalization failures and a throwing diagnostic sink cannot leave an unobserved rejection or poison FIFO", async () => {
  const setup = await savedPreview();
  const { original } = setup;
  let throwUpdate = true;
  const queue = createImageQueue(
    () => {
      if (throwUpdate) throw undefined;
    },
    () => undefined,
  );
  const logs: LogEntry[] = [];
  let throwLog = false;
  const enqueue = (key: string) =>
    enqueueBoundary(queue, key, setup, (entry) => {
      if (
        throwLog &&
        (entry.event === "image.queue.completed" || entry.stage === "image.queue.finalize")
      )
        throw new Error("logging sink unavailable");
      logs.push(entry);
    });
  const first = await enqueue("non-error");
  await queue.wait(first);
  expect(first.failure?.message).toBe("Image completion failed");
  expect(queue.pending(original.id)).toBeUndefined();
  throwUpdate = false;
  throwLog = true;
  const brokenSink = await enqueue("broken-sink");
  await expect(queue.wait(brokenSink)).rejects.toThrow("logging sink unavailable");
  expect(queue.pending(original.id)).toBeUndefined();
  throwLog = false;
  const recovered = await enqueue("recovered");
  await queue.wait(recovered);
  expect(recovered.state).toBe("completed");
});

async function fullDraft(setup: Awaited<ReturnType<typeof savedPreview>>) {
  const secondaryPortraits = await Promise.all(
    Array.from({ length: 5 }, async () => ({
      style: "photo" as const,
      imageUrl: await setup.store.saveImage(portraitImage),
    })),
  );
  return {
    id: setup.original.id,
    base: serializePersona(setup.original),
    preview: serializePersona({ ...setup.original, secondaryPortraits }),
  };
}

test("registration adopts completed cached photos before reserving any new paid slots", async () => {
  const setup = await savedPreview();
  const latest = await fullDraft(setup);
  const update = vi.fn<Parameters<typeof createImageQueue>[0]>();
  const queue = createImageQueue(update, () => latest);
  await expect(enqueueBoundary(queue, "overflow", setup, () => {})).rejects.toMatchObject({
    kind: "invalid",
    message: copy.galleryFull,
  });
  expect(queue.pending(setup.original.id)).toBeUndefined();
  expect(update).not.toHaveBeenCalled();
});

test("a legacy failed-batch retry validates current capacity before entering the worker", async () => {
  const setup = await savedPreview();
  let latest: Draft | undefined;
  const queue = createImageQueue(
    (_id, next) => {
      latest = next;
    },
    () => latest,
  );
  vi.spyOn(subGenerator, "portrait").mockRejectedValueOnce(new Error("a failed image"));
  const job = await enqueueBoundary(queue, "failed", setup, () => {});
  await queue.wait(job);
  expect(job.state).toBe("failed");
  latest = await fullDraft(setup);
  expect(() => queue.retryFailed(job.id, latest!)).toThrow(
    expect.objectContaining({ kind: "invalid", message: copy.galleryFull }),
  );
  expect(queue.pending(setup.original.id)).toBeUndefined();
});

test.each(["mismatched", "missing"])(
  "a preparation failure preserves its own signed source when the cache is %s",
  async (state) => {
    const setup = await savedPreview();
    const original = serializePersona(setup.original);
    const cached: Draft = {
      id: setup.original.id,
      base: "old snapshot",
      preview: serializePersona({ ...setup.original, name: "old unrelated preview" }),
    };
    const update = vi.fn<Parameters<typeof createImageQueue>[0]>();
    const queue = createImageQueue(update, () => (state === "missing" ? undefined : cached));
    vi.spyOn(setup.store, "get").mockRejectedValueOnce(new Error("storage read unavailable"));
    const logs: LogEntry[] = [];
    const job = await enqueueBoundary(queue, "failed-prepare", setup, (entry) => logs.push(entry));
    await queue.wait(job);
    expect(job.state).toBe("failed");
    expect(update.mock.calls.at(-1)?.[1]).toMatchObject({ base: original, preview: original });
    expect(logs.filter((entry) => entry.event === "operation.failed")).toHaveLength(1);
    expect(logs.find((entry) => entry.event === "operation.failed")!.stage).toBe(
      "image.queue.batch",
    );
  },
);

test("the real queue completion summary measures elapsed time instead of the absolute clock", async () => {
  const setup = await savedPreview();
  let clock = 100;
  let wallClock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(Date, "now").mockImplementation(() => wallClock);
  const generate = subGenerator.portrait;
  vi.spyOn(subGenerator, "portrait").mockImplementation((...args) => {
    clock = 160;
    wallClock = 1600;
    return generate(...args);
  });
  const queue = createImageQueue(
    () => {},
    () => undefined,
  );
  const logs: LogEntry[] = [];
  const job = await enqueueBoundary(queue, "timed", setup, (entry) => logs.push(entry));
  await queue.wait(job);
  expect(job.state).toBe("completed");
  expect(job.tasks[0]!.durationMs).toBe(600);
  expect(logs.find((entry) => entry.event === "image.queue.completed")!.durationMs).toBe(60);
});

test("registration rejects a regeneration target replaced in the latest preview before queueing payment", async () => {
  const setup = await savedPreview();
  const { original, store } = setup;
  const imageUrl = await store.saveImage(portraitImage);
  const draft = {
    id: original.id,
    base: serializePersona(original),
    preview: serializePersona(original),
    imageCount: 1,
    imageInstructions: "",
  };
  const latest = {
    ...draft,
    preview: serializePersona({
      ...original,
      imageUrl,
      portraits: { ...original.portraits, photo: imageUrl },
    }),
  };
  const batch = createImageBatch(
    original,
    draft,
    "regenerate",
    new URLSearchParams({ style: "photo", image: original.portraits!.photo! }),
    `photo:${original.portraits!.photo}`,
    subGenerator,
    store,
  );
  const queue = createImageQueue(
    () => {},
    () => latest,
  );
  expect(() => queue.enqueue("stale replacement", batch)).toThrow(
    expect.objectContaining({ kind: "conflict", message: copy.stale }),
  );
  expect(queue.pending(original.id)).toBeUndefined();
});
