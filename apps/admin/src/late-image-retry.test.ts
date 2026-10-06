import { expect, test, vi } from "vitest";
import { Window } from "happy-dom";
import { personaImages } from "@ren-ai/personas";
import { character, generator, request, tokenOf } from "../test/fixtures.ts";
import { savedPreview, preview, subGenerator } from "../test/sub-portraits.ts";
import { queuedRequest, jobUrl, finishedJob } from "../test/queue.ts";

test("retry after another successful batch keeps all newer photos and can continue after saving a partial profile", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, route, editing } = await savedPreview({ ...subGenerator, portrait });
  portrait.mockRejectedValueOnce(new Error("first failed"));
  const accepted = await admin(
    queuedRequest(
      `${route}?style=photo`,
      { ...character, draft: tokenOf(editing), intent: "subportrait", imageCount: "2" },
      ["first", "second"],
    ),
  );
  const path = jobUrl(accepted);
  const partial = await finishedJob(admin, path);
  const newer = await admin(
    queuedRequest(
      `${route}?style=photo`,
      { ...character, draft: tokenOf(partial), intent: "subportrait", imageCount: "1" },
      ["another completed picture"],
    ),
  );
  const added = await finishedJob(admin, jobUrl(newer));
  const before = personaImages(preview(added)).map((image) => image.imageUrl);
  expect(
    (await admin(request(route, { ...character, draft: tokenOf(added), intent: "save" }))).status,
  ).toBe(303);
  const current = await (await admin(request(path))).text();
  expect(
    (
      await admin(
        queuedRequest(`${path}/retry?image=0`, {
          ...character,
          draft: tokenOf(current),
          portraitInstructions: "late retry",
        }),
      )
    ).status,
  ).toBe(303);
  const complete = await finishedJob(admin, path);
  expect(preview(complete).secondaryPortraits).toHaveLength(3);
  expect(personaImages(preview(complete)).map((image) => image.imageUrl)).toEqual(
    expect.arrayContaining(before),
  );
  expect(portrait).toHaveBeenCalledTimes(6);
});

test("a late retry cannot exceed a style's capacity or resurrect an already regenerated image", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, route, editing } = await savedPreview({ ...subGenerator, portrait });
  portrait.mockRejectedValueOnce(new Error("failed addition"));
  const accepted = await admin(
    queuedRequest(`${route}?style=photo`, {
      ...character,
      draft: tokenOf(editing),
      intent: "subportrait",
    }),
  );
  const path = jobUrl(accepted);
  const partial = await finishedJob(admin, path);
  const fill = await admin(
    queuedRequest(`${route}?style=photo`, {
      ...character,
      draft: tokenOf(partial),
      intent: "subportrait",
      imageCount: "5",
    }),
  );
  await finishedJob(admin, jobUrl(fill));
  const current = await (await admin(request(path))).text();
  expect(
    (
      await admin(
        queuedRequest(`${path}/retry?image=0`, {
          ...character,
          draft: tokenOf(current),
          portraitInstructions: "over capacity",
        }),
      )
    ).status,
  ).toBe(400);
  expect(portrait).toHaveBeenCalledTimes(8);
  const main = preview(current).portraits!.anime!;
  portrait.mockRejectedValueOnce(new Error("failed regeneration"));
  const old = await admin(
    queuedRequest(`${route}?style=anime&image=${encodeURIComponent(main)}`, {
      ...character,
      draft: tokenOf(current),
      intent: "regenerate",
      portraitInstructions: "first attempt",
    }),
  );
  const oldPath = jobUrl(old);
  const failed = await finishedJob(admin, oldPath);
  const replacement = await admin(
    queuedRequest(`${route}?style=anime&image=${encodeURIComponent(main)}`, {
      ...character,
      draft: tokenOf(failed),
      intent: "regenerate",
      portraitInstructions: "new successful attempt",
    }),
  );
  await finishedJob(admin, jobUrl(replacement));
  const latest = await (await admin(request(oldPath))).text();
  expect(
    (
      await admin(
        queuedRequest(`${oldPath}/retry?image=0`, {
          ...character,
          draft: tokenOf(latest),
          portraitInstructions: "stale target",
        }),
      )
    ).status,
  ).toBe(409);
  expect(portrait).toHaveBeenCalledTimes(10);
});

test("a forged old-source retry cannot overwrite a newer fully regenerated character", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, route, editing } = await savedPreview({ ...subGenerator, portrait });
  portrait.mockRejectedValueOnce(new Error("failed addition"));
  const failed = await admin(
    queuedRequest(`${route}?style=photo`, {
      ...character,
      draft: tokenOf(editing),
      intent: "subportrait",
    }),
  );
  const path = jobUrl(failed);
  const partial = await finishedJob(admin, path);
  const changed = await admin(
    queuedRequest(route, {
      ...character,
      name: "Changed character",
      draft: tokenOf(partial),
      intent: "generate",
    }),
  );
  await finishedJob(admin, jobUrl(changed));
  const latest = await (await admin(request(path))).text();
  expect(
    (
      await admin(
        queuedRequest(`${path}/retry?image=0`, {
          ...character,
          draft: tokenOf(latest),
          portraitInstructions: "old source",
        }),
      )
    ).status,
  ).toBe(409);
  expect(portrait).toHaveBeenCalledTimes(5);
});

test("a failed regeneration row retries one owned target and preserves the opposite style", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, route, editing, original } = await savedPreview({ ...subGenerator, portrait });
  portrait.mockRejectedValueOnce(new Error("regeneration failure"));
  const accepted = await admin(
    queuedRequest(`${route}?style=photo&image=0`, {
      ...character,
      draft: tokenOf(editing),
      intent: "regenerate",
      portraitInstructions: "original retry prompt",
    }),
  );
  const path = jobUrl(accepted);
  const failed = await finishedJob(admin, path);
  expect(
    (
      await admin(
        queuedRequest(`${path}/retry?image=0`, {
          ...character,
          draft: tokenOf(failed),
          portraitInstructions: "new retry prompt",
        }),
      )
    ).status,
  ).toBe(303);
  const completed = await finishedJob(admin, path);
  expect(preview(completed).portraits?.anime).toBe(original.portraits?.anime);
  expect(preview(completed).portraits?.photo).not.toBe(original.portraits?.photo);
  expect(portrait).toHaveBeenCalledTimes(4);
  const window = new Window();
  try {
    window.document.body.innerHTML = completed;
    expect(window.document.querySelector(".queue-thumbnail img")?.getAttribute("src")).toBe(
      preview(completed).portraits!.photo!.replace(/^\/discovery\/images\//, "/images/"),
    );
  } finally {
    await window.happyDOM.close();
  }
});

test("retrying a failed regeneration at full photo capacity replaces exactly one photo without applying addition limits", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, route, editing } = await savedPreview({ ...subGenerator, portrait });
  const fill = await admin(
    queuedRequest(`${route}?style=photo`, {
      ...character,
      draft: tokenOf(editing),
      intent: "subportrait",
      imageCount: "5",
    }),
  );
  const filled = await finishedJob(admin, jobUrl(fill));
  portrait.mockRejectedValueOnce(new Error("failed replacement"));
  const regen = await admin(
    queuedRequest(`${route}?style=photo&image=0`, {
      ...character,
      draft: tokenOf(filled),
      intent: "regenerate",
    }),
  );
  const path = jobUrl(regen);
  const failed = await finishedJob(admin, path);
  expect(
    (
      await admin(
        queuedRequest(`${path}/retry?image=0`, {
          ...character,
          draft: tokenOf(failed),
          portraitInstructions: "replace one",
        }),
      )
    ).status,
  ).toBe(303);
  const completed = await finishedJob(admin, path);
  expect(personaImages(preview(completed)).filter((image) => image.style === "photo")).toHaveLength(
    6,
  );
  expect(portrait).toHaveBeenCalledTimes(9);
});
