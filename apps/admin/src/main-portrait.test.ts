import { expect, test, vi } from "vitest";
import { personaImages } from "@ren-ai/personas";
import {
  character,
  generator,
  request,
  tokenOf,
  portraitImage,
  fixture,
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

useBrowser();

test("each style's representative can change without generating or losing photos, and is public first only after saving", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page, store } = await basePreview({ ...subGenerator, portrait });
  let current = page;
  for (const style of ["photo", "anime"] as const)
    current = await (await addPortrait(admin, current, style, "2")).text();
  const original = preview(current);
  await store.create({ ...original, published: true });
  const route = `/personas/${original.id}`;
  current = await (await admin(request(route))).text();
  for (const style of ["photo", "anime"] as const) {
    const before = preview(current);
    const selected = before.secondaryPortraits!.find((image) => image.style === style)!;
    document.body.innerHTML = current;
    const button = document.querySelector<HTMLButtonElement>(
      `#portrait-gallery-${style} [value="set-main"]`,
    )!;
    expect(button.textContent).toBe("대표로 지정");
    expect(button.disabled).toBe(false);
    const response = await admin(
      request(button.getAttribute("formaction")!, {
        ...character,
        draft: tokenOf(current),
        intent: "set-main",
        published: "on",
      }),
    );
    expect(response.status).toBe(200);
    current = await response.text();
    const after = preview(current);
    expect(after.portraits?.[style]).toBe(selected.imageUrl);
    const other = style === "photo" ? "anime" : "photo";
    expect(after.portraits?.[other]).toBe(before.portraits?.[other]);
    expect(after.secondaryPortraits).toContainEqual({ style, imageUrl: before.portraits![style]! });
    expect(
      personaImages(after)
        .map((image) => image.imageUrl)
        .toSorted(),
    ).toEqual(
      personaImages(before)
        .map((image) => image.imageUrl)
        .toSorted(),
    );
    expect(after.bio).toBe(before.bio);
    expect(after.imageUrl).toBe(after.portraits?.photo);
    expect((await store.publicList())[0]?.portraits).toEqual(original.portraits);
    document.body.innerHTML = current;
    expect(document.querySelector(`#portrait-gallery-${style} figcaption`)?.textContent).toBe(
      "대표 · 외모 기준",
    );
    expect(
      document
        .querySelector(`#portrait-gallery-${style} [value="delete-image"]`)
        ?.getAttribute("data-confirm-delete"),
    ).toContain("추가 1 사진이 새 대표 · 외모 기준");
  }
  expect(portrait).toHaveBeenCalledTimes(6);
  expect(
    (await admin(request(route, { ...character, draft: tokenOf(current), published: "on" })))
      .status,
  ).toBe(303);
  const publicProfile = (await store.publicList())[0]!;
  expect(publicProfile.portraits).toEqual(preview(current).portraits);
  expect(publicProfile.secondaryPortraits).toEqual(preview(current).secondaryPortraits);
});

test("representative regeneration always attaches the existing same-style identity", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page } = await basePreview({ ...subGenerator, portrait });
  let current = page;
  for (const [style, reference] of [
    ["photo", photoPortrait],
    ["anime", portraitImage],
  ] as const) {
    const response = await admin(
      request(`/personas?style=${style}&image=0`, {
        ...character,
        draft: tokenOf(current),
        intent: "regenerate",
      }),
    );
    expect(response.status).toBe(200);
    current = await response.text();
    expect(portrait.mock.calls.at(-1)?.slice(3)).toEqual([reference, undefined]);
  }
});

test("deleted and invalid representative targets are rejected and external identity images never generate unanchored replacements", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page } = await basePreview({ ...subGenerator, portrait });
  const added = await (await addPortrait(admin, page)).text();
  const url = preview(added).secondaryPortraits![0]!.imageUrl;
  const route = `/personas?style=photo&image=${encodeURIComponent(url)}`;
  const fields = { ...character, draft: tokenOf(added) };
  expect((await admin(request(route, { ...fields, intent: "delete-image" }))).status).toBe(200);
  expect((await admin(request(route, { ...fields, intent: "set-main" }))).status).toBe(409);
  expect(
    (await admin(request("/personas?style=other&image=0", { ...fields, intent: "set-main" })))
      .status,
  ).toBe(400);
  expect(portrait).toHaveBeenCalledTimes(3);
  const external = await fixture({ ...subGenerator, portrait });
  await external.store.create(legacy);
  const path = `/personas/${legacy.id}`;
  const editing = await (await external.admin(request(path))).text();
  expect(
    (
      await external.admin(
        request(`${path}?style=photo&image=0`, {
          name: legacy.name,
          description: legacy.prompt,
          draft: tokenOf(editing),
          intent: "regenerate",
        }),
      )
    ).status,
  ).toBe(400);
  expect(portrait).toHaveBeenCalledTimes(3);
});
