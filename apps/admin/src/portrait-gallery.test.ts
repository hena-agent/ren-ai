import { expect, test, vi } from "vitest";
import { personaImages, serializePersona } from "@ren-ai/personas";
import { createProfileGenerator } from "./generation.ts";
import { draftTokens } from "./draft.ts";
import {
  character,
  femaleCharacter,
  generator,
  idOf,
  portraitImage,
  portraitReply,
  request,
  tokenOf,
} from "../test/fixtures.ts";
import {
  basePreview,
  photoPortrait,
  preview,
  subGenerator,
  publishPreview,
} from "../test/sub-portraits.ts";
import policy from "./policy.json";

test("initial creation makes two mains only, and the obsolete recommendation action cannot trigger paid work", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, store, page } = await basePreview({
    ...subGenerator,
    portrait,
  });
  expect(portrait.mock.calls).toEqual([
    [femaleCharacter, "anime", "extra"],
    [femaleCharacter, "photo", "extra"],
  ]);
  expect(
    (
      await admin(
        request("/personas?style=photo", { ...character, draft: tokenOf(page), intent: "plan" }),
      )
    ).status,
  ).toBe(400);
  expect(portrait).toHaveBeenCalledTimes(2);
  expect(page).not.toContain('class="sub-recommendation"');
  expect(page).not.toContain("추가됨");
  expect(page).not.toContain("장면 1 /");
  expect(draftTokens("test-password").decode(tokenOf(page))).not.toHaveProperty("recommendation");
  const saved = await publishPreview(admin, page);
  const record = await store.get(idOf(saved));
  expect(serializePersona(record)).not.toContain("private recommendation reason");
  const reopened = await (await admin(request(`/personas/${record.id}`))).text();
  expect(reopened).not.toContain("private recommendation reason");
  expect(reopened).not.toContain('class="sub-recommendation"');
});

test("a selected style adds one independent image and never regenerates its opposite style or the main images", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page, store, logs } = await basePreview({ ...subGenerator, portrait });
  const base = preview(page);
  const fields = {
    ...character,
    draft: tokenOf(page),
    intent: "subportrait",
    imageDirection: "private selfie idea",
    portraitInstructions: "private optional tweak",
  };
  const first = await (await admin(request("/personas?style=photo", fields))).text();
  const next = preview(first);
  expect(next.portraits).toEqual(base.portraits);
  expect(next.secondaryPortraits).toHaveLength(1);
  expect(next.secondaryPortraits?.[0]?.style).toBe("photo");
  expect(portrait).toHaveBeenCalledTimes(3);
  expect(portrait.mock.calls.at(-1)).toEqual([
    femaleCharacter,
    "photo",
    "private selfie idea\n\nOPERATOR DIRECTION:\nprivate optional tweak",
    photoPortrait,
  ]);
  const replay = await admin(request("/personas?style=photo", fields));
  expect(preview(await replay.text())).toEqual(next);
  expect(portrait).toHaveBeenCalledTimes(3);
  expect(await store.publicList()).toEqual([]);
  const saved = await publishPreview(admin, first);
  const record = await store.get(idOf(saved));
  for (const image of personaImages(record))
    expect((await store.publicImage(image.imageUrl.split("/").at(-1)!)).status).toBe(200);
  for (const value of ["private selfie idea", "private optional tweak"]) {
    expect(serializePersona(record)).not.toContain(value);
    expect(JSON.stringify(logs)).not.toContain(value);
    expect(JSON.stringify(await store.publicList())).not.toContain(value);
  }
});

test("image generation preserves style-specific identity inputs without insisting on a universal crop", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(portraitReply);
  const model = createProfileGenerator({ key: "key", fetcher });
  for (const [style, reference] of [
    ["anime", portraitImage],
    ["photo", photoPortrait],
  ] as const) {
    expect(await model.portrait(character, style, "full-body travel photo", reference)).toEqual(
      portraitImage,
    );
    expect(await new Request(...fetcher.mock.calls.at(-1)!).json()).toMatchObject({
      contents: [
        {
          parts: [
            {
              text: `${policy.portraits[style]}\n\n${policy.subPortraitDirection}\n\n${policy.profilePhotoDirection}\n\n${policy.genderDirection}\n\n${character.name}\n${character.description}\n\nADDITIONAL PORTRAIT INSTRUCTIONS:\nfull-body travel photo`,
            },
            {
              inlineData: {
                mimeType: reference.mimeType,
                data: Buffer.from(reference.bytes).toString("base64"),
              },
            },
          ],
        },
      ],
    });
  }
});
