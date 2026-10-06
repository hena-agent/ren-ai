import { expect, test, vi } from "vitest";
import { personaImages } from "@ren-ai/personas";
import { character, generator, request, tokenOf } from "../test/fixtures.ts";
import { basePreview, preview, subGenerator } from "../test/sub-portraits.ts";
import { draftTokens } from "./draft.ts";
import { photoVariation } from "./image-generation.ts";

test("a new draft, changed count or private direction is a distinct selected addition, while exact replay is free", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page, logs } = await basePreview({ ...subGenerator, portrait });
  const fields = {
    ...character,
    draft: tokenOf(page),
    intent: "subportrait",
    imageCount: "1",
    imageDirection: "first direction",
    portraitInstructions: "tweak",
  };
  const added = await (await admin(request("/personas?style=photo", fields))).text();
  const newer = await (
    await admin(request("/personas?style=photo", { ...fields, draft: tokenOf(added) }))
  ).text();
  expect(preview(newer).secondaryPortraits).toHaveLength(2);
  const changed = await (
    await admin(request("/personas?style=photo", { ...fields, imageDirection: "second direction" }))
  ).text();
  expect(preview(changed).secondaryPortraits).toHaveLength(3);
  const batch = await admin(request("/personas?style=photo", { ...fields, imageCount: "2" }));
  expect(batch.status).toBe(200);
  const filled = await batch.text();
  expect(
    logs
      .filter(
        (entry) =>
          entry.requestId === batch.headers.get("x-request-id") &&
          entry.stage === "portrait.generate" &&
          entry.event === "operation.started",
      )
      .map((entry) => entry.poseIndex),
  ).toEqual([4, 5]);
  expect(preview(filled).secondaryPortraits).toHaveLength(5);
  expect(portrait).toHaveBeenCalledTimes(7);
  expect(portrait.mock.calls.slice(-2).map((call) => call[2])).toEqual(
    [4, 5].map(
      (position) =>
        `first direction\n\nOPERATOR DIRECTION:\ntweak\n\nPHOTO DIRECTION:\n${photoVariation(position)}`,
    ),
  );
  const replay = await admin(request("/personas?style=photo", { ...fields, imageCount: "2" }));
  expect(replay.status).toBe(200);
  expect(preview(await replay.text())).toEqual(preview(filled));
  expect(portrait).toHaveBeenCalledTimes(7);
});

test("a partial anime-only main regenerates its legacy image projection without creating a photo", async () => {
  const { admin, page, store } = await basePreview();
  const original = preview(page);
  await store.create({
    ...original,
    imageUrl: original.portraits!.anime!,
    portraits: { anime: original.portraits!.anime! },
  });
  const route = `/personas/${original.id}`;
  const editing = await (await admin(request(route))).text();
  const next = await admin(
    request(`${route}?style=anime&image=0`, {
      ...character,
      draft: tokenOf(editing),
      intent: "regenerate",
    }),
  );
  expect(next.status).toBe(200);
  const record = preview(await next.text());
  expect(record.imageUrl).toBe(record.portraits?.anime);
  expect(record.imageUrl).not.toBe(original.portraits!.anime);
  expect(record.portraits?.photo).toBeUndefined();
});

test("raw private direction diagnostics are redacted, and the boundary accepts exactly 4000 characters", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page, logs } = await basePreview({ ...subGenerator, portrait });
  portrait.mockRejectedValueOnce(new Error("private image direction alone"));
  expect(
    (
      await admin(
        request("/personas?style=photo", {
          ...character,
          draft: tokenOf(page),
          intent: "subportrait",
          imageDirection: "private image direction alone",
          portraitInstructions: "separate tweak",
        }),
      )
    ).status,
  ).toBe(503);
  expect(JSON.stringify(logs)).not.toContain("private image direction alone");
  const accepted = await admin(
    request("/personas?style=photo", {
      ...character,
      draft: tokenOf(page),
      intent: "subportrait",
      imageDirection: "x".repeat(4000),
    }),
  );
  expect(accepted.status).toBe(200);
  expect(portrait.mock.calls.at(-1)?.[2]).toBe("x".repeat(4000));
});

test("a signed older form adds against the latest wholly regenerated main images", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page } = await basePreview({ ...subGenerator, portrait });
  const newer = await (
    await admin(request("/personas", { ...character, draft: tokenOf(page), intent: "portrait" }))
  ).text();
  const added = await (
    await admin(
      request("/personas?style=photo", {
        ...character,
        draft: tokenOf(page),
        intent: "subportrait",
      }),
    )
  ).text();
  expect(preview(added).portraits).toEqual(preview(newer).portraits);
  expect(preview(added).secondaryPortraits).toHaveLength(1);
});

test("deletion keeps photo-preferred legacy projection and safe empty prompt context, with replay preserving subsequent private edits", async () => {
  const { admin, page } = await basePreview();
  const original = preview(page);
  const route = `/personas?style=anime&image=${encodeURIComponent(original.portraits!.anime!)}`;
  const fields = { ...character, draft: tokenOf(page), intent: "delete-image" };
  const deleted = await (await admin(request(route, fields))).text();
  expect(preview(deleted).imageUrl).toBe(original.portraits!.photo!);
  const deletedDraft = draftTokens("test-password").decode(tokenOf(deleted));
  expect(deletedDraft.imageEditing).toBe(true);
  for (const field of [
    "imageInstructions",
    "portraitInstructions",
    "portraitOperation",
    "imageCount",
    "imageDirection",
  ])
    expect(deletedDraft).not.toHaveProperty(field);
  const changed = await (
    await admin(
      request(`/personas?style=photo&image=${encodeURIComponent(original.portraits!.photo!)}`, {
        ...character,
        draft: tokenOf(deleted),
        intent: "regenerate",
        portraitInstructions: "new private editing prompt",
        published: "on",
      }),
    )
  ).text();
  const replay = await (await admin(request(route, fields))).text();
  expect(draftTokens("test-password").decode(tokenOf(replay))).toEqual(
    draftTokens("test-password").decode(tokenOf(changed)),
  );
  expect(personaImages(preview(replay))).toHaveLength(1);
});

test("one URL reused across independent styles still replaces only the chosen style", async () => {
  const { admin, page, store } = await basePreview();
  const original = preview(page);
  const shared = original.portraits!.photo!;
  await store.create({
    ...original,
    secondaryPortraits: [
      { style: "anime", imageUrl: shared },
      { style: "photo", imageUrl: shared },
    ],
  });
  const route = `/personas/${original.id}`;
  const editing = await (await admin(request(route))).text();
  const replacement = await admin(
    request(`${route}?style=anime&image=${encodeURIComponent(shared)}`, {
      ...character,
      draft: tokenOf(editing),
      intent: "regenerate",
    }),
  );
  expect(replacement.status).toBe(200);
  const after = preview(await replacement.text());
  expect(after.secondaryPortraits?.find((image) => image.style === "photo")?.imageUrl).toBe(shared);
  expect(after.secondaryPortraits?.find((image) => image.style === "anime")?.imageUrl).not.toBe(
    shared,
  );
  expect(after.imageUrl).toBe(shared);
});
