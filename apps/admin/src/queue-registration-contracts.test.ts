import { expect, test, vi } from "vitest";
import { character, generator, request, tokenOf } from "../test/fixtures.ts";
import { savedPreview, subGenerator, preview } from "../test/sub-portraits.ts";
import { queuedRequest, jobUrl, finishedJob } from "../test/queue.ts";
import { personaImages } from "@ren-ai/personas";

test("queued registration rejects stale snapshots and external mains before returning a job URL", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, original, store, route, editing } = await savedPreview({
    ...subGenerator,
    portrait,
  });
  await store.update({ ...original, name: "Changed outside editor" });
  expect(
    (
      await admin(
        queuedRequest(route, { ...character, draft: tokenOf(editing), intent: "generate" }),
      )
    ).status,
  ).toBe(409);
  await store.update({
    ...original,
    portraits: { photo: "https://example.net/external.jpg" },
    imageUrl: "https://example.net/external.jpg",
  });
  const current = await (await admin(request(route))).text();
  const rejected = await admin(
    queuedRequest(`${route}?style=photo`, {
      ...character,
      draft: tokenOf(current),
      intent: "subportrait",
    }),
  );
  expect(rejected.status).toBe(400);
  expect(rejected.headers.get("location")).toBeNull();
  expect(portrait).toHaveBeenCalledTimes(2);
});

test("changing only a second-photo input or the per-photo protocol is a distinct confirmed action", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, route, editing } = await savedPreview({ ...subGenerator, portrait });
  const fields = { ...character, draft: tokenOf(editing), intent: "portrait", imageCount: "1" };
  const separate = queuedRequest(route, fields, ["first instruction", "second instruction"]);
  const legacy = new Request(separate, {
    method: "POST",
    body: new URLSearchParams({
      ...fields,
      portraitInstructions: "first instruction",
      imagePrompts: "second instruction",
    }),
  });
  const first = await admin(legacy);
  const firstPath = jobUrl(first);
  await finishedJob(admin, firstPath);
  const second = await admin(
    queuedRequest(route, fields, ["first instruction", "second instruction"]),
  );
  const secondPath = jobUrl(second);
  expect(secondPath).not.toBe(firstPath);
  await finishedJob(admin, secondPath);
  const changed = await admin(
    queuedRequest(route, fields, ["first instruction", "different second instruction"]),
  );
  expect(jobUrl(changed)).not.toBe(secondPath);
  await finishedJob(admin, jobUrl(changed));
  expect(portrait.mock.calls.slice(2).map((call) => call[2])).toEqual([
    "first instruction",
    "first instruction",
    "first instruction",
    "second instruction",
    "first instruction",
    "different second instruction",
  ]);
});

test("an older failed job view displays the newest approved editing photos and job routes match only exact private paths", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, route, editing } = await savedPreview({ ...subGenerator, portrait });
  portrait.mockRejectedValueOnce(new Error("failed addition"));
  const first = await admin(
    queuedRequest(`${route}?style=photo`, {
      ...character,
      draft: tokenOf(editing),
      intent: "subportrait",
    }),
  );
  const path = jobUrl(first);
  const failed = await finishedJob(admin, path);
  const second = await admin(
    queuedRequest(`${route}?style=photo`, {
      ...character,
      draft: tokenOf(failed),
      intent: "subportrait",
      portraitInstructions: "newer photo",
    }),
  );
  const newest = await finishedJob(admin, jobUrl(second));
  const oldView = await (await admin(request(path))).text();
  for (const image of personaImages(preview(newest)))
    expect(oldView).toContain(
      `src="${image.imageUrl.replace(/^\/discovery\/images\//, "/images/")}"`,
    );
  expect((await admin(request(`${path}/extra`))).status).toBe(404);
  expect((await admin(request(`/prefix${path}`))).status).toBe(404);
});

test("an updated retry carries request-boundary job identity and correlated private-input exclusion", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, route, editing, original, logs } = await savedPreview({
    ...subGenerator,
    portrait,
  });
  portrait.mockRejectedValueOnce(new Error("failed"));
  const accepted = await admin(
    queuedRequest(`${route}?style=photo`, {
      ...character,
      draft: tokenOf(editing),
      intent: "subportrait",
    }),
  );
  const path = jobUrl(accepted);
  const failed = await finishedJob(admin, path);
  const retry = await admin(
    queuedRequest(`${path}/retry?image=0`, {
      ...character,
      draft: tokenOf(failed),
      portraitInstructions: "retry",
    }),
  );
  await finishedJob(admin, path);
  const completion = logs.find(
    (entry) =>
      entry.requestId === retry.headers.get("x-request-id") && entry.event === "request.completed",
  );
  expect(completion?.jobId).toBe(path.split("/").at(-1));
  expect(completion?.personaId).toBe(original.id);
});
