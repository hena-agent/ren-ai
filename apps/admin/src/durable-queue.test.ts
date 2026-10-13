import { expect, test, vi } from "vitest";
import { loggedJob } from "./logging.ts";
import {
  character,
  generator,
  initialDocuments,
  newToken,
  portraitImage,
  request,
  tokenOf,
} from "../test/fixtures.ts";
import { preview } from "../test/sub-portraits.ts";
import { serializePersona } from "@ren-ai/personas";
import { databasePersona } from "../test/cloudflare-fixture.ts";
import { durableFixture } from "../test/durable-admin.ts";

test("durable FIFO resumes between alarms, preserves completed siblings and deduplicates paid submissions", async () => {
  const calls: string[] = [];
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(async (_, style) => {
    calls.push(style);
    return portraitImage;
  });
  const { store, open } = await durableFixture({ ...generator, portrait });
  let admin = open();
  const token = await newToken(admin);
  const submission = request("/personas", {
    ...character,
    draft: token,
    intent: "generate",
    imageCount: "2",
  });
  const registered = await admin(submission.clone());
  expect(registered.status).toBe(303);
  const jobUrl = registered.headers.get("location")!;
  expect(calls).toEqual([]);
  expect((await admin(submission.clone())).headers.get("location")).toBe(jobUrl);
  const step = async () => {
    const job = admin.nextJob()!;
    await loggedJob(job.requestId, { jobId: job.id }, admin.runNext, () => {});
  };
  await step();
  expect(calls).toEqual(["anime"]);
  const firstPage = await (await admin(request(jobUrl))).text();
  const firstImage = preview(firstPage).portraits!.anime;
  admin = open();
  expect((await admin(submission.clone())).headers.get("location")).toBe(jobUrl);
  await step();
  await step();
  await step();
  expect(calls).toEqual(["anime", "photo", "anime", "photo"]);
  expect(admin.nextJob()).toBeUndefined();
  await loggedJob("idle", {}, admin.runNext, () => {});
  const complete = await (await admin(request(jobUrl))).text();
  expect(preview(complete).portraits!.anime).toBe(firstImage);
  expect(preview(complete).secondaryPortraits).toHaveLength(2);
  const save = await admin(
    request("/personas", {
      ...character,
      draft: tokenOf(complete),
      intent: "save",
      published: "on",
      stateSource: initialDocuments.state,
      memorySource: initialDocuments.memory,
    }),
  );
  expect(save.status).toBe(303);
  expect(await store.publicList()).toHaveLength(1);
});

test("an interrupted shared character preparation blocks dependent photos until an operator retries", async () => {
  const convert = vi.fn<typeof generator.convert>().mockImplementation(generator.convert);
  const { open, state, logs } = await durableFixture({ ...generator, convert });
  let admin = open();
  await admin(
    request("/personas", {
      name: character.name,
      description: "A basic private character idea.",
      draft: await newToken(admin),
      intent: "generate",
    }),
  );
  state.saved!.queue.jobs[0]!.tasks[0]!.state = "saving";
  admin = open();
  const job = admin.nextJob()!;
  await loggedJob(job.requestId, { jobId: job.id }, admin.runNext, (entry) => logs.push(entry));
  expect(convert).not.toHaveBeenCalled();
  expect(admin.nextJob()).toBeUndefined();
  expect(logs.filter((entry) => entry.code === "interrupted")).toMatchObject([
    {
      requestId: job.requestId,
      jobId: job.id,
      stage: "image.queue.recovery",
      style: "anime",
      imageOrdinal: 0,
    },
  ]);
});

test("a queued stale snapshot fails before paid calls and retains its conflict after restart", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockResolvedValue(portraitImage);
  const { store, open } = await durableFixture({ ...generator, portrait });
  await store.save(databasePersona, initialDocuments, { persona: "" });
  let admin = open();
  const token = tokenOf(await (await admin(request(`/personas/${databasePersona.id}`))).text());
  const registered = await admin(
    request(`/personas/${databasePersona.id}`, { ...character, draft: token, intent: "generate" }),
  );
  const original = await store.get(databasePersona.id);
  await store.save({ ...original, language: "en" }, initialDocuments, {
    persona: serializePersona(original),
    initial: initialDocuments,
  });
  const job = admin.nextJob()!;
  await loggedJob(job.requestId, { jobId: job.id }, admin.runNext, () => {});
  expect(portrait).not.toHaveBeenCalled();
  expect(admin.nextJob()).toBeUndefined();
  admin = open();
  expect(await (await admin(request(registered.headers.get("location")!))).text()).toContain(
    "변경",
  );
});

test("storage failure keeps FIFO locked, does not pay twice, and is exposed with a request ID", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockResolvedValue(portraitImage);
  const { open, state } = await durableFixture({ ...generator, portrait });
  const admin = open();
  await admin(
    request("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
  );
  const first = admin.nextJob()!;
  await admin(
    request("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
  );
  state.unavailable = true;
  await expect(
    loggedJob(first.requestId, { jobId: first.id }, admin.runNext, () => {}),
  ).rejects.toThrow("storage unavailable");
  expect(admin.nextJob()!.id).toBe(first.id);
  expect(portrait).not.toHaveBeenCalled();
  const failed = await admin(request(`/image-jobs/${first.id}`));
  expect(failed.status).toBe(503);
  expect(await failed.text()).toContain(failed.headers.get("x-request-id")!);
  state.unavailable = false;
  await loggedJob(first.requestId, { jobId: first.id }, admin.runNext, () => {});
  expect(admin.nextJob()!.id).not.toBe(first.id);
  expect(portrait).not.toHaveBeenCalled();
});

test("an interrupted paid task is not automatically called again; later safe photos still complete", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockResolvedValue(portraitImage);
  const { open, state } = await durableFixture({ ...generator, portrait });
  let admin = open();
  const registered = await admin(
    request("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
  );
  const jobUrl = registered.headers.get("location")!;
  state.saved!.queue.jobs[0]!.tasks[0]!.state = "generating";
  admin = open();
  let job = admin.nextJob()!;
  await loggedJob(job.requestId, { jobId: job.id }, admin.runNext, () => {});
  expect(portrait).toHaveBeenCalledTimes(1);
  expect(portrait.mock.calls[0]![1]).toBe("photo");
  expect(admin.nextJob()).toBeUndefined();
  const page = await (await admin(request(jobUrl))).text();
  expect(preview(page).portraits!.photo).toBeTruthy();
  expect(preview(page).portraits!.anime).toBeUndefined();
  const retry = await admin(
    request(`${jobUrl}/retry?image=0`, {
      ...character,
      draft: tokenOf(page),
      portraitInstructions: "retry this photo only",
    }),
  );
  expect(retry.status).toBe(303);
  job = admin.nextJob()!;
  await loggedJob(job.requestId, { jobId: job.id }, admin.runNext, () => {});
  expect(portrait).toHaveBeenCalledTimes(2);
  expect(portrait.mock.calls[1]![2]).toBe("retry this photo only");
  const done = await (await admin(request(jobUrl))).text();
  expect(preview(done).portraits!.photo).toBe(preview(page).portraits!.photo);
});
