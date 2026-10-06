import { expect, test, vi } from "vitest";
import { personaImages } from "@ren-ai/personas";
import { createAdmin } from "./admin.ts";
import { draftTokens } from "./draft.ts";
import {
  character,
  femaleCharacter,
  generator,
  fixture,
  legacy,
  request,
  tokenOf,
} from "../test/fixtures.ts";
import {
  basePreview,
  preview,
  subGenerator,
  publishPreview,
  addPortrait,
} from "../test/sub-portraits.ts";

test("an independent image is replaced once by stable URL without changing other images or biography", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page } = await basePreview({ ...subGenerator, portrait });
  let current = page;
  for (const style of ["anime", "photo"] as const)
    current = await (
      await admin(
        request(`/personas?style=${style}`, {
          ...character,
          draft: tokenOf(current),
          intent: "subportrait",
          portraitInstructions: "travel photo",
        }),
      )
    ).text();
  const originals = personaImages(preview(current));
  for (const original of originals) {
    const before = preview(current);
    const fields = {
      ...character,
      draft: tokenOf(current),
      intent: "regenerate",
      portraitInstructions: "private one-image instruction",
    };
    const route = `/personas?image=${encodeURIComponent(original.imageUrl)}&style=${original.style}`;
    const count = portrait.mock.calls.length;
    const response = await admin(request(route, fields));
    expect(response.status).toBe(200);
    current = await response.text();
    const after = preview(current);
    expect(portrait).toHaveBeenCalledTimes(count + 1);
    expect(after.bio).toBe(before.bio);
    expect(after.imageUrl).toBe(
      original.main && original.style === "photo" ? after.portraits?.photo : before.imageUrl,
    );
    expect(personaImages(after)).toHaveLength(4);
    expect(
      personaImages(after).filter((image) => image.imageUrl === original.imageUrl),
    ).toHaveLength(0);
    const unchanged = personaImages(before)
      .filter((image) => image.imageUrl !== original.imageUrl)
      .map((image) => image.imageUrl);
    expect(
      personaImages(after)
        .filter((image) => unchanged.includes(image.imageUrl))
        .map((image) => image.imageUrl),
    ).toEqual(unchanged);
    expect(preview(await (await admin(request(route, fields))).text())).toEqual(after);
    expect(portrait).toHaveBeenCalledTimes(count + 1);
  }
  expect(portrait.mock.calls.at(-1)?.slice(0, 3)).toEqual([
    femaleCharacter,
    "photo",
    "private one-image instruction",
  ]);
});

test("deleting one style preserves the opposite image, promotes only same-style photos and requires explicit save", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page, store } = await basePreview({ ...subGenerator, portrait });
  const added = await (await addPortrait(admin, page)).text();
  const saved = await publishPreview(admin, added);
  expect(saved.status).toBe(303);
  const original = preview(added);
  const route = `/personas/${original.id}`;
  const editing = await (await admin(request(route))).text();
  const main = original.portraits!.photo!;
  const response = await admin(
    request(`${route}?image=${encodeURIComponent(main)}&style=photo`, {
      ...character,
      draft: tokenOf(editing),
      intent: "delete-image",
    }),
  );
  expect(response.status).toBe(200);
  const removed = await response.text();
  expect(preview(removed).portraits?.anime).toBe(original.portraits?.anime);
  expect(preview(removed).portraits?.photo).toBe(original.secondaryPortraits?.[0]?.imageUrl);
  expect((await store.publicImage(main.split("/").at(-1)!)).status).toBe(200);
  expect(
    (await admin(request(route, { ...character, draft: tokenOf(removed), published: "on" })))
      .status,
  ).toBe(303);
  expect((await store.publicImage(main.split("/").at(-1)!)).status).toBe(404);
  expect(portrait).toHaveBeenCalledTimes(3);
  let remaining = await (await admin(request(route))).text();
  for (const image of personaImages(preview(remaining)))
    remaining = await (
      await admin(
        request(`${route}?image=${encodeURIComponent(image.imageUrl)}&style=${image.style}`, {
          ...character,
          draft: tokenOf(remaining),
          intent: "delete-image",
        }),
      )
    ).text();
  expect(personaImages(preview(remaining))).toEqual([]);
  expect(preview(remaining).published).toBe(false);
  expect((await admin(request(route, { ...character, draft: tokenOf(remaining) }))).status).toBe(
    303,
  );
  expect(await store.publicList()).toEqual([]);
});

test("failed regeneration retains image, optional prompt, cause metadata and a successful retry changes only one file", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page, store, logs } = await basePreview({ ...subGenerator, portrait });
  const before = preview(page);
  const url = before.portraits!.photo!;
  const route = `/personas?image=${encodeURIComponent(url)}&style=photo`;
  const fields = {
    ...character,
    draft: tokenOf(page),
    intent: "regenerate",
    portraitInstructions: "private retry instruction",
  };
  portrait.mockRejectedValueOnce(new Error("private retry instruction"));
  const failed = await admin(request(route, fields));
  expect(failed.status).toBe(503);
  const retained = await failed.text();
  expect(preview(retained)).toEqual(before);
  expect(draftTokens("test-password").decode(tokenOf(retained)).imageInstructions).toBe(
    "private retry instruction",
  );
  expect(logs.find((entry) => entry.event === "operation.failed")).toMatchObject({
    requestId: failed.headers.get("x-request-id"),
    stage: "portrait.generate",
    poseIndex: 0,
    style: "photo",
    error: { message: "<REDACTED>" },
  });
  const disk = vi
    .spyOn(store, "saveImage")
    .mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
  expect((await admin(request(route, { ...fields, draft: tokenOf(retained) }))).status).toBe(503);
  expect(logs.find((entry) => entry.code === "ENOSPC")).toMatchObject({ stage: "image.save" });
  disk.mockRestore();
  const recovered = await admin(
    request(route, { ...fields, draft: tokenOf(retained), portraitInstructions: "" }),
  );
  expect(recovered.status).toBe(200);
  expect(preview(await recovered.text()).portraits?.anime).toBe(before.portraits?.anime);
});

test("invalid styles, images and changed definitions are rejected before paid work", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page } = await basePreview({ ...subGenerator, portrait });
  const fields = { ...character, draft: tokenOf(page), intent: "regenerate" };
  for (const query of [
    "",
    "image=-1&style=photo",
    "image=6&style=photo",
    "image=1&style=photo",
    "image=0&style=toString",
    "image=0&style=other",
    "image=%200&style=photo",
    "image=0%20&style=photo",
  ])
    expect((await admin(request(`/personas?${query}`, fields))).status).toBe(400);
  expect(
    (
      await admin(
        request("/personas?image=0&style=photo", { ...fields, description: "new source" }),
      )
    ).status,
  ).toBe(400);
  expect(portrait).toHaveBeenCalledTimes(2);
});

test("legacy single image replacement preserves its format and works with a signed draft after restart", async () => {
  const { admin, store } = await fixture();
  await store.create(legacy);
  const path = `/personas/${legacy.id}`;
  const page = await (await admin(request(path))).text();
  const fields = {
    name: legacy.name,
    description: legacy.prompt,
    draft: tokenOf(page),
    intent: "regenerate",
  };
  const next = await (await admin(request(`${path}?image=0&style=photo`, fields))).text();
  expect(preview(next).imageUrl).not.toBe(legacy.imageUrl);
  expect((await store.get(legacy.id)).imageUrl).toBe(legacy.imageUrl);
  const fresh = createAdmin(store, "test-password", "", { generator, log: () => {} });
  expect(
    (await fresh(request(`${path}?image=0&style=photo`, { ...fields, draft: tokenOf(next) })))
      .status,
  ).toBe(200);
});
