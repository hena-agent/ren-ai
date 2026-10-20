import { expect, test, vi } from "vitest";
import { createPersonaStore } from "@ren-ai/personas";
import { Window } from "happy-dom";
import { createProfileGenerator } from "./generation.ts";
import {
  fixture,
  character,
  femaleCharacter,
  generator,
  request,
  tokenOf,
  idOf,
  png,
  legacy,
} from "../test/fixtures.ts";
import copy from "./copy.json";
import { renderPage } from "./page.tsx";
import { ageOn } from "@ren-ai/personas/birth-date";
import { sheet } from "../test/character.ts";
import { basePreview } from "../test/sub-portraits.ts";

test("incomplete list cards retain readable placeholders without image-management actions", async () => {
  const window = new Window();
  try {
    window.document.body.innerHTML = renderPage({
      personas: [{ ...legacy, name: "", bio: "", imageUrl: "" }],
    });
    expect(window.document.querySelector(".persona-card h3")?.textContent).toBe(copy.noName);
    expect(window.document.querySelector(".persona-card p")?.textContent).toBe(copy.noBio);
    expect(window.document.querySelector(".image-placeholder")?.textContent).toBe(copy.noImage);
    expect(
      window.document.querySelector('[value="regenerate"], [value="delete-image"]'),
    ).toBeNull();
  } finally {
    await window.happyDOM.close();
  }
});

test("both styles are saved together, survive restart and become public without operator selection", async () => {
  const portraits = vi
    .fn<typeof generator.portrait>()
    .mockResolvedValue({ bytes: png, mimeType: "image/png" });
  const { admin, store, root, page } = await basePreview({ ...generator, portrait: portraits });
  const window = new Window();
  let images: string[];
  try {
    window.document.body.innerHTML = page;
    images = [...window.document.querySelectorAll(".image-option img")].map((image) =>
      image.getAttribute("src")!,
    );
    expect(images).toHaveLength(2);
    const comparison = window.document.querySelector("section.image-options");
    expect(comparison?.getAttribute("aria-label")).toBe(copy.comparison);
    expect(comparison?.querySelectorAll(".portrait-style")).toHaveLength(2);
    for (const style of ["photo", "anime"]) {
      const heading = comparison?.querySelector(`#portrait-${style}-title`);
      expect(heading?.closest("section")?.getAttribute("aria-labelledby")).toBe(
        `portrait-${style}-title`,
      );
    }
    expect(comparison?.querySelector("fieldset, legend")).toBeNull();
    expect(
      [...window.document.querySelectorAll(".image-option img")].map((image) =>
        image.getAttribute("alt"),
      ),
    ).toEqual([
      `${character.name} ${copy.styles.photo} · 사진 1`,
      `${character.name} ${copy.styles.anime} · 사진 1`,
    ]);
    expect(
      [...window.document.querySelectorAll(".image-option figcaption")].map(
        (caption) => caption.textContent,
      ),
    ).toEqual(["사진 1", "사진 1"]);
    expect(window.document.querySelector('[name="imageChoice"]')).toBeNull();
    expect(window.document.querySelector('input[type="radio"]')).toBeNull();
  } finally {
    await window.happyDOM.close();
  }
  expect(portraits).toHaveBeenCalledWith(
    femaleCharacter,
    "anime",
    "extra",
    expect.objectContaining({ mimeType: "image/png" }),
  );
  expect(portraits).toHaveBeenCalledWith(
    femaleCharacter,
    "photo",
    "extra",
    expect.objectContaining({ mimeType: "image/jpeg" }),
  );
  expect(page).toContain(copy.styles.anime);
  expect(page).toContain(copy.styles.photo);
  for (const image of images!)
    expect((await store.image(image.split("/").at(-1)!)).status).toBe(200);
  const saved = await admin(
    request("/personas", { ...character, draft: tokenOf(page), published: "on" }),
  );
  expect(saved.status).toBe(303);
  const reopened = await createPersonaStore(root);
  const record = await reopened.get(idOf(saved));
  expect(record.portraits).toEqual({ anime: images![1], photo: images![0] });
  for (const image of images!)
    expect((await reopened.image(image.split("/").at(-1)!)).status).toBe(200);
  expect(await reopened.publicList()).toEqual([
    {
      id: record.id,
      name: character.name,
      age: ageOn(sheet.birthDate),
      bio: record.bio,
      imageUrl: record.imageUrl,
      portraits: record.portraits,
      secondaryPortraits: [],
      profile: { introduction: record.bio, sections: [] },
    },
  ]);
  const edited = await (await admin(request(`/personas/${record.id}`))).text();
  expect(edited).toContain(images![0]!);
  expect(edited).toContain(images![1]!);
  await admin(request(`/personas/${record.id}`, { ...character, draft: tokenOf(edited) }));
  for (const image of images!)
    expect((await reopened.image(image.split("/").at(-1)!)).status).toBe(200);
});

test("saved previews keep external portrait URLs intact and use authenticated routes for owned images", async () => {
  const { admin, store } = await fixture();
  const owned = await store.saveImage({ bytes: png, mimeType: "image/png" });
  const external = `https://example.net${owned}`;
  await store.create({ ...legacy, imageUrl: owned, portraits: { anime: external, photo: owned } });
  await store.create({ ...legacy, id: "single", imageUrl: owned });
  const window = new Window();
  try {
    window.document.body.innerHTML = await (await admin(request("/"))).text();
    const card = window.document.querySelector('a[href="/personas/legacy"]');
    expect(card?.className).toBe("card-link");
    expect(card?.querySelectorAll(".portrait-pane")).toHaveLength(2);
    expect([...card!.querySelectorAll(".portrait-pane")].map((pane) => pane.className)).toEqual([
      "portrait-pane portrait-anime",
      "portrait-pane portrait-photo",
    ]);
    expect(
      [...card!.querySelectorAll(".portrait-pane img")].map((image) => [
        image.getAttribute("src"),
        image.getAttribute("alt"),
      ]),
    ).toEqual([
      [external, `${legacy.name} ${copy.styles.anime}`],
      [owned, `${legacy.name} ${copy.styles.photo}`],
    ]);
    expect(
      [...card!.querySelectorAll(".portrait-label")].map((label) => [
        label.className,
        label.textContent,
        label.getAttribute("aria-hidden"),
      ]),
    ).toEqual([
      ["portrait-label portrait-label-anime", copy.portraitLabels.anime, "true"],
      ["portrait-label portrait-label-photo", copy.portraitLabels.photo, "true"],
    ]);
    const single = window.document.querySelector('a[href="/personas/single"]');
    expect(single?.querySelector(".portrait-split")).toBeNull();
    expect(single?.querySelectorAll("img")).toHaveLength(1);
    const thumbnail = single?.querySelector(".persona-card img");
    expect(thumbnail?.getAttribute("src")).toBe(owned);
    expect(thumbnail?.getAttribute("alt")).toBe(`${legacy.name} 프로필`);
    window.document.body.innerHTML = await (await admin(request(`/personas/${legacy.id}`))).text();
    expect(
      [...window.document.querySelectorAll(".image-option img")].map((image) =>
        image.getAttribute("src"),
      ),
    ).toEqual([owned, external]);
  } finally {
    await window.happyDOM.close();
  }
});

test("client-supplied image choices cannot replace either saved style", async () => {
  const { admin, store, page } = await basePreview();
  const response = await admin(
    request("/personas", {
      ...character,
      draft: tokenOf(page),
      imageChoice: "https://evil.example/replace.jpg",
      portraits: "injected",
      published: "on",
    }),
  );
  expect(response.status).toBe(303);
  const record = await store.get(idOf(response));
  expect(record.portraits?.anime).toMatch(/^\/images\//);
  expect(record.portraits?.photo).toMatch(/^\/images\//);
  expect(JSON.stringify(await store.publicList())).not.toContain("evil.example");
});

test("portrait requests use distinct art direction while preserving the character definition", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }],
          },
        },
      ],
    }),
  );
  const model = createProfileGenerator({ key: "key", fetcher });
  await model.portrait(character, "anime");
  await model.portrait(character, "photo");
  const anime = await new Request(...fetcher.mock.calls[0]!).text();
  const photo = await new Request(...fetcher.mock.calls[1]!).text();
  expect(anime).toContain("LovePlus");
  expect(anime).toContain("2D Japanese");
  expect(anime).toContain("hand-drawn 2D");
  expect(anime).toContain("cel shading");
  expect(photo).toContain("photorealistic personal dating-profile photo");
  expect(photo).toMatch(/natural skin texture/i);
  expect(anime).toContain(character.name);
  expect(photo).toContain(character.name);
  expect(anime).not.toBe(photo);
});
