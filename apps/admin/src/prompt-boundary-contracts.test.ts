import { expect, test, vi } from "vitest";
import { character, fixture, generator, newToken, request, tokenOf } from "../test/fixtures.ts";
import { subGenerator, savedPreview } from "../test/sub-portraits.ts";
import { queuedRequest, jobUrl, finishedJob } from "../test/queue.ts";

test("per-photo inputs are trimmed, accept the exact boundary and cannot replace a required first input with an uploaded file", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, route, editing, store } = await savedPreview({ ...subGenerator, portrait });
  const storeRead = vi.spyOn(store, "image");
  const accepted = await admin(
    queuedRequest(
      `${route}?style=photo`,
      { ...character, draft: tokenOf(editing), intent: "subportrait", imageCount: "2" },
      ["  a selfie  ", "x".repeat(4000)],
    ),
  );
  await finishedJob(admin, jobUrl(accepted));
  expect(storeRead).toHaveBeenCalledTimes(1);
  expect(portrait.mock.calls.slice(-2).map((call) => call[2])).toEqual([
    "a selfie",
    "x".repeat(4000),
  ]);
  const empty = await fixture();
  const first = {
    ...character,
    draft: await newToken(empty.admin),
    intent: "generate",
    imageCount: "1",
  };
  const form = new FormData();
  for (const [key, value] of Object.entries({ ...first, separateImagePrompts: "1" }))
    form.set(key, value);
  form.set("portraitInstructions", new File(["not text"], "input.txt"));
  form.set("imagePrompts", "second input");
  expect(
    (await empty.admin(new Request(request("/personas"), { method: "POST", body: form }))).status,
  ).toBe(400);
});

test("the legacy whole-image action also receives one input per actual photo, and the eleventh task has a valid individual retry", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, route, editing } = await savedPreview({ ...subGenerator, portrait });
  const instructions = Array.from(
    { length: 12 },
    (_, index) => `photo-specific direction ${index}`,
  );
  portrait.mockImplementation(async (person, style, prompt, reference, composition) => {
    if (prompt === instructions[10]) throw new Error("eleventh image failed");
    return subGenerator.portrait(person, style, prompt, reference, composition);
  });
  const accepted = await admin(
    queuedRequest(
      route,
      { ...character, draft: tokenOf(editing), intent: "portrait", imageCount: "6" },
      instructions,
    ),
  );
  expect(accepted.status).toBe(303);
  const path = jobUrl(accepted);
  const partial = await finishedJob(admin, path);
  expect(portrait.mock.calls.slice(2).map((call) => call[2])).toEqual(instructions);
  portrait.mockImplementation(subGenerator.portrait);
  const retry = await admin(
    queuedRequest(`${path}/retry?image=10`, {
      ...character,
      draft: tokenOf(partial),
      portraitInstructions: "eleventh retry",
    }),
  );
  expect(retry.status).toBe(303);
  expect(jobUrl(retry)).toBe(path);
  await finishedJob(admin, path);
  expect(portrait).toHaveBeenCalledTimes(15);
});
