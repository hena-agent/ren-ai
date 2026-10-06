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
  newToken,
  tokenOf,
  idOf,
  png,
  legacy,
} from "../test/fixtures.ts";
import copy from "./copy.json";

test("both styles are saved together, survive restart and become public without operator selection", async () => {
  const portraits = vi
    .fn<typeof generator.portrait>()
    .mockResolvedValue({ bytes: png, mimeType: "image/png" });
  const { admin, store, root } = await fixture({ ...generator, portrait: portraits });
  const page = await (
    await admin(
      request("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
    )
  ).text();
  const window = new Window();
  let images: string[];
  try {
    window.document.body.innerHTML = page;
    images = [...window.document.querySelectorAll(".image-option img")].map(
      (image) => `/discovery${image.getAttribute("src")}`,
    );
    expect(images).toHaveLength(2);
    const comparison = window.document.querySelector("section.image-options");
    expect(comparison?.getAttribute("aria-labelledby")).toBe("comparison-title");
    expect(comparison?.getAttribute("aria-describedby")).toBe("comparison-hint");
    expect(comparison?.querySelector("#comparison-title")?.textContent).toBe(copy.comparison);
    expect(comparison?.querySelector("fieldset, legend")).toBeNull();
    expect(
      [...window.document.querySelectorAll(".image-option img")].map((image) =>
        image.getAttribute("alt"),
      ),
    ).toEqual([`${character.name} ${copy.styles.anime}`, `${character.name} ${copy.styles.photo}`]);
    expect(
      [...window.document.querySelectorAll(".image-option figcaption")].map(
        (caption) => caption.textContent,
      ),
    ).toEqual([
      `${copy.mainImage} · ${copy.styles.anime}`,
      `${copy.mainImage} · ${copy.styles.photo}`,
    ]);
    expect(window.document.querySelector('[name="imageChoice"]')).toBeNull();
    expect(window.document.querySelector('input[type="radio"]')).toBeNull();
  } finally {
    await window.happyDOM.close();
  }
  expect(portraits).toHaveBeenCalledWith(femaleCharacter, "anime");
  expect(portraits).toHaveBeenCalledWith(femaleCharacter, "photo");
  expect(page).toContain(copy.styles.anime);
  expect(page).toContain(copy.styles.photo);
  for (const image of images!)
    expect((await store.publicImage(image.split("/").at(-1)!)).status).toBe(404);
  const saved = await admin(
    request("/personas", { ...character, draft: tokenOf(page), published: "on" }),
  );
  expect(saved.status).toBe(303);
  const reopened = await createPersonaStore(root);
  const record = await reopened.get(idOf(saved));
  expect(record.portraits).toEqual({ anime: images![0], photo: images![1] });
  for (const image of images!)
    expect((await reopened.publicImage(image.split("/").at(-1)!)).status).toBe(200);
  expect(await reopened.publicList()).toEqual([
    {
      id: record.id,
      name: character.name,
      bio: record.bio,
      imageUrl: record.imageUrl,
      portraits: record.portraits,
    },
  ]);
  const edited = await (await admin(request(`/personas/${record.id}`))).text();
  expect(edited).toContain(images![0]!.replace("/discovery", ""));
  expect(edited).toContain(images![1]!.replace("/discovery", ""));
  await admin(request(`/personas/${record.id}`, { ...character, draft: tokenOf(edited) }));
  for (const image of images!)
    expect((await reopened.publicImage(image.split("/").at(-1)!)).status).toBe(404);
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
      [owned.replace("/discovery", ""), `${legacy.name} ${copy.styles.photo}`],
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
    expect(thumbnail?.getAttribute("src")).toBe(owned.replace("/discovery", ""));
    expect(thumbnail?.getAttribute("alt")).toBe(`${legacy.name} 프로필`);
    window.document.body.innerHTML = await (await admin(request(`/personas/${legacy.id}`))).text();
    expect(
      [...window.document.querySelectorAll(".image-option img")].map((image) =>
        image.getAttribute("src"),
      ),
    ).toEqual([external, owned.replace("/discovery", "")]);
  } finally {
    await window.happyDOM.close();
  }
});

test("client-supplied image choices cannot replace either saved style", async () => {
  const { admin, store } = await fixture();
  const page = await (
    await admin(
      request("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
    )
  ).text();
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
  expect(record.portraits?.anime).toMatch(/^\/discovery\/images\//);
  expect(record.portraits?.photo).toMatch(/^\/discovery\/images\//);
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
