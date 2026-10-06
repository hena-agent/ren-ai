import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createPersonaStore } from "./store.ts";
import { decodePersona, parsePersona, serializePersona } from "./model.ts";
import { personaImages } from "./portraits.ts";
import { stringify } from "yaml";

const persona = {
  id: "gallery",
  name: "인물",
  bio: "공개 소개",
  imageUrl: "https://example.net/base.jpg",
  published: true,
  language: "ko",
  timeZone: "Asia/Seoul",
  openingLine: "Hi",
  memory: "Remember",
  prompt: "Private source",
};
const pair = { anime: "https://example.net/anime.jpg", photo: "https://example.net/photo.jpg" };

test("legacy grouped images migrate losslessly to independent mains and secondary pictures", () => {
  const legacy = { ...persona, portraits: pair, portraitGallery: [pair, pair] };
  const converted = decodePersona(legacy);
  expect(converted.portraits).toEqual(pair);
  expect(converted.secondaryPortraits).toEqual([
    { style: "anime", imageUrl: pair.anime },
    { style: "photo", imageUrl: pair.photo },
  ]);
  expect(converted).not.toHaveProperty("portraitGallery");
  expect(serializePersona(legacy)).not.toContain("portrait-gallery:");
  expect(parsePersona(legacy.id, serializePersona(legacy))).toEqual(converted);
  const source = serializePersona(persona).replace(
    "\n---\n",
    `\n${stringify({ "portrait-gallery": [pair, pair] })}---\n`,
  );
  expect(parsePersona(persona.id, source)).toEqual(converted);
  for (const portraitGallery of [
    [],
    Array.from({ length: 7 }, () => pair),
    [{ anime: pair.anime }],
    [{ ...pair, photo: "javascript:alert(1)" }],
  ])
    expect(() => decodePersona({ ...persona, portraitGallery })).toThrow(
      /portraitGallery|URL|HTTPS/,
    );
});

test("independent images allow partial main styles but reject empty mains, invalid styles, excessive counts and unsafe URLs", () => {
  expect(decodePersona({ ...persona, portraits: { photo: pair.photo } }).portraits).toEqual({
    photo: pair.photo,
  });
  expect(decodePersona({ ...persona, portraits: { anime: pair.anime } }).portraits).toEqual({
    anime: pair.anime,
  });
  for (const style of ["anime", "photo"] as const) {
    expect(() =>
      decodePersona({
        ...persona,
        secondaryPortraits: Array.from({ length: 6 }, () => ({ style, imageUrl: pair[style] })),
      }),
    ).toThrow(/서브/);
    expect(
      decodePersona({
        ...persona,
        secondaryPortraits: Array.from({ length: 5 }, () => ({ style, imageUrl: pair[style] })),
      }).secondaryPortraits,
    ).toHaveLength(5);
  }
  for (const input of [
    { portraits: {} },
    { secondaryPortraits: [{ style: "other", imageUrl: pair.photo }] },
    { secondaryPortraits: [{ style: "photo", imageUrl: "javascript:alert(1)" }] },
    {
      secondaryPortraits: Array.from({ length: 6 }, () => ({
        style: "photo",
        imageUrl: pair.photo,
      })),
    },
    {
      secondaryPortraits: Array.from({ length: 11 }, () => ({
        style: "photo",
        imageUrl: pair.photo,
      })),
    },
  ])
    expect(() => decodePersona({ ...persona, ...input })).toThrow(
      /portraits|secondaryPortraits|서브|HTTPS/,
    );
});

test("public images are authorized by current independent metadata and survive restart without proposal records", async () => {
  const root = await mkdtemp(join(tmpdir(), "independent-public-"));
  try {
    const store = await createPersonaStore(root);
    const urls = await Promise.all(
      Array.from({ length: 4 }, () =>
        store.saveImage({ bytes: Buffer.from("89504e470d0a1a0a", "hex"), mimeType: "image/png" }),
      ),
    );
    const record = {
      ...persona,
      imageUrl: urls[1]!,
      portraits: { anime: urls[0]!, photo: urls[1]! },
      secondaryPortraits: [{ style: "photo" as const, imageUrl: urls[2]! }],
    };
    await store.create(record);
    const reopened = await createPersonaStore(root);
    expect(await reopened.get(persona.id)).toEqual(record);
    expect((await reopened.publicList())[0]?.secondaryPortraits).toEqual(record.secondaryPortraits);
    for (const image of personaImages(record))
      expect((await reopened.publicImage(image.imageUrl.split("/").at(-1)!)).status).toBe(200);
    expect((await reopened.publicImage(urls[3]!.split("/").at(-1)!)).status).toBe(404);
    await reopened.update({ ...record, secondaryPortraits: [] });
    expect((await reopened.publicImage(urls[2]!.split("/").at(-1)!)).status).toBe(404);
    await reopened.update({ ...record, published: false });
    expect((await reopened.publicImage(urls[0]!.split("/").at(-1)!)).status).toBe(404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
