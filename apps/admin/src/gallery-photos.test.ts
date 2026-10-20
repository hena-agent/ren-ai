import { expect, test, vi } from "vitest";
import { personaImages } from "@ren-ai/personas";
import {
  character,
  fixture,
  generator,
  request,
  tokenOf,
  portraitImage,
  legacy,
} from "../test/fixtures.ts";
import {
  basePreview,
  addPortrait,
  preview,
  photoPortrait,
  subGenerator,
} from "../test/sub-portraits.ts";
import { useBrowser } from "../test/browser.ts";
import { savedPreview } from "../test/sub-portraits.ts";
import { queuedRequest, jobUrl, finishedJob } from "../test/queue.ts";

useBrowser();

test("a failed photo cannot be paid again when its sheet disappears before the row retry runs", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, store, route, editing, original } = await savedPreview({
    ...subGenerator,
    portrait,
  });
  portrait.mockRejectedValueOnce(new Error("photo unavailable"));
  const queued = await admin(
    queuedRequest(`${route}?style=photo`, {
      ...character,
      draft: tokenOf(editing),
      intent: "generate",
    }),
  );
  const path = jobUrl(queued);
  const failed = await finishedJob(admin, path);
  expect(portrait).toHaveBeenCalledTimes(3);
  await store.clearSheets(original.id);
  const retry = await admin(
    queuedRequest(`${path}/retry?image=0`, { ...character, draft: tokenOf(failed) }),
  );
  expect(retry.status).toBe(303);
  const blocked = await finishedJob(admin, path);
  expect(blocked).toContain('data-state="blocked"');
  expect(portrait).toHaveBeenCalledTimes(3);
  expect(personaImages(preview(blocked))).toEqual(personaImages(original));
  document.body.innerHTML = await (await admin(request(route))).text();
  expect(document.querySelector<HTMLButtonElement>("#portrait-add-photo")?.disabled).toBe(true);
});

test("all gallery photos have the same actions and deleting the first preserves order, sheets and public photos until save", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page, store } = await basePreview({ ...subGenerator, portrait });
  const expanded = await (await addPortrait(admin, page, "photo", "2")).text();
  const before = preview(expanded);
  const sheets = await store.sheets(before.id);
  await store.create({ ...before, published: true });
  const route = `/personas/${before.id}`;
  const editing = await (await admin(request(route))).text();
  document.body.innerHTML = editing;
  expect(document.querySelector('[value="set-main"]')).toBeNull();
  expect(document.body.textContent).not.toContain("대표");
  expect(document.body.textContent).not.toContain("전체 사진 다시 생성");
  expect(
    [...document.querySelectorAll("#portrait-gallery-photo figcaption")].map(
      (node) => node.textContent,
    ),
  ).toEqual(["사진 1", "사진 2", "사진 3"]);
  const images = personaImages(before).filter((image) => image.style === "photo");
  expect(images.every((image) => !("main" in image))).toBe(true);
  const deleted = await admin(
    request(`${route}?style=photo&image=${encodeURIComponent(images[0]!.imageUrl)}`, {
      ...character,
      draft: tokenOf(editing),
      published: "on",
      intent: "delete-image",
    }),
  );
  const afterPage = await deleted.text();
  const after = preview(afterPage);
  expect(personaImages(after).filter((image) => image.style === "photo")).toEqual(images.slice(1));
  expect(after.portraits?.anime).toBe(before.portraits?.anime);
  expect(await store.sheets(before.id)).toEqual(sheets);
  expect((await store.publicList())[0]?.portraits).toEqual(before.portraits);
  expect(
    (await admin(request(route, { ...character, draft: tokenOf(afterPage), published: "on" })))
      .status,
  ).toBe(303);
  expect((await store.publicList())[0]?.portraits?.photo).toBe(images[1]!.imageUrl);
  expect(portrait).toHaveBeenCalledTimes(4);
});

test("every photo, including the first, regenerates using the sheet and its current scene without changing siblings", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page } = await basePreview({ ...subGenerator, portrait });
  let current = await (await addPortrait(admin, page, "photo")).text();
  const originals = personaImages(preview(current));
  for (const target of originals) {
    const before = personaImages(preview(current));
    const response = await admin(
      request(`/personas?style=${target.style}&image=${encodeURIComponent(target.imageUrl)}`, {
        ...character,
        draft: tokenOf(current),
        intent: "regenerate",
      }),
    );
    expect(response.status).toBe(200);
    current = await response.text();
    const reference = target.style === "anime" ? portraitImage : photoPortrait;
    expect(portrait.mock.calls.at(-1)?.slice(3)).toEqual([reference, reference]);
    expect(
      personaImages(preview(current)).filter((image) => image.imageUrl !== target.imageUrl),
    ).toHaveLength(before.length);
    for (const sibling of before.filter((image) => image.imageUrl !== target.imageUrl))
      expect(personaImages(preview(current))).toContainEqual(sibling);
  }
});

test("removed representative and whole-profile actions are rejected and generation requires an explicit style", async () => {
  const { admin, page } = await basePreview();
  for (const intent of ["set-main", "portrait", "subportrait"]) {
    expect(
      (
        await admin(
          request("/personas?style=photo&image=0", { ...character, draft: tokenOf(page), intent }),
        )
      ).status,
    ).toBe(400);
  }
  const submitted = request("/personas?style=photo", {
    ...character,
    draft: tokenOf(page),
    intent: "generate",
  });
  const missingStyle = new Request("http://localhost:3729/personas", submitted);
  expect((await admin(missingStyle)).status).toBe(400);
});

test("an existing gallery does not permit generation or regeneration without its own style's sheet", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockResolvedValue(portraitImage);
  const { admin, store } = await fixture({ ...generator, portrait });
  const imageUrl = await store.saveImage(portraitImage);
  await store.create({ ...legacy, imageUrl });
  const route = `/personas/${legacy.id}`;
  const page = await (await admin(request(route))).text();
  document.body.innerHTML = page;
  expect(document.querySelector<HTMLButtonElement>("#portrait-add-photo")?.disabled).toBe(true);
  expect(document.querySelector<HTMLButtonElement>("#portrait-regenerate-photo-0")?.disabled).toBe(
    true,
  );
  for (const intent of ["generate", "regenerate"])
    expect(
      (
        await admin(
          request(`${route}?style=photo&image=${encodeURIComponent(imageUrl)}`, {
            name: legacy.name,
            description: legacy.prompt,
            draft: tokenOf(page),
            intent,
          }),
        )
      ).status,
    ).toBe(400);
  expect(portrait).not.toHaveBeenCalled();
});
