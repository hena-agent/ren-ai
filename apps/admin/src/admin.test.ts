import { createPersonaStore, loadPersonas } from "@ren-ai/personas";
import { Effect } from "effect";
import { Window } from "happy-dom";
import type { HTMLInputElement, HTMLTextAreaElement } from "happy-dom";
import { expect, test, vi } from "vitest";
import { createAdmin } from "./admin.ts";
import {
  fixture,
  character,
  femaleCharacter,
  introduction,
  generator,
  legacy,
  png,
  request,
  tokenOf,
  newToken,
  idOf,
} from "../test/fixtures.ts";
import copy from "./copy.json";
import { preview } from "../test/sub-portraits.ts";

test("the authoring form asks for name and a long description, with no internal configuration fields", async () => {
  const { admin } = await fixture();
  const window = new Window();
  try {
    const empty = await admin(request("/"));
    expect(empty.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(empty.headers.get("cache-control")).toBe("no-store");
    expect(empty.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(empty.headers.get("content-security-policy")).toContain("script-src 'self'");
    const emptyPage = await empty.text();
    expect(emptyPage).toContain(copy.empty);
    expect(emptyPage).toContain('aria-current="page"');
    const page = await (await admin(request("/new"))).text();
    expect(page).toMatch(/^<!doctype html>/);
    window.document.write(page);
    expect(window.document.title).toBe("Ren AI / Admin");
    expect(window.document.querySelector("form")?.getAttribute("action")).toBe("/personas");
    expect(window.document.querySelector("#persona-editor")?.getAttribute("action")).toBe(
      "/personas",
    );
    expect(window.document.querySelector("form")?.getAttribute("method")).toBe("post");
    for (const name of [
      "id",
      "imageUrl",
      "bio",
      "openingLine",
      "memory",
      "prompt",
      "language",
      "timeZone",
    ])
      expect(window.document.querySelector(`[name="${name}"]`)).toBeNull();
    expect(window.document.querySelector<HTMLInputElement>("#name")?.required).toBe(true);
    const description = window.document.querySelector<HTMLTextAreaElement>("#description")!;
    expect(description.value).toBe("");
    expect(description.getAttribute("rows")).toBe("16");
    expect(description.required).toBe(true);
    expect(description.getAttribute("aria-describedby")).toBe("description-hint");
    expect(
      [...window.document.querySelectorAll("fieldset label")].map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(["성별 선택", "간단한 설명", "이름", "캐릭터 설명", "프로필 공개"]);
    for (const label of window.document.querySelectorAll("label"))
      expect(window.document.getElementById(label.getAttribute("for")!)).not.toBeNull();
    expect(window.document.querySelector<HTMLInputElement>("#published")?.checked).toBe(false);
    expect(window.document.querySelector('[value="portrait"]')).toBeNull();
    expect(window.document.querySelector("[data-pending]")).not.toBeNull();
    expect(window.document.querySelector("script")?.getAttribute("src")).toBe("/pending.js");
    expect(window.document.querySelector("aside h2")?.textContent).toBe(copy.preview);
    expect(window.document.querySelector(".persona-card h3")?.textContent).toBe(copy.noName);
    expect(window.document.querySelector(".persona-card p")?.textContent).toBe(copy.noBio);
    expect(window.document.querySelector(".image-placeholder")?.textContent).toBe(copy.noImage);
    expect(window.document.querySelector(".badge")?.className).toBe("badge");
    expect(window.document.querySelector('[role="alert"]')).toBeNull();
    expect(window.document.querySelector(".notice.success")).toBeNull();
    expect(tokenOf(page)).not.toBe("");
    for (const [route, type, content] of [
      ["/style.css", "text/css; charset=utf-8", "test styles"],
      ["/pending.js", "text/javascript; charset=utf-8", "test script"],
    ]) {
      const resource = await admin(request(route!));
      expect(resource.headers.get("content-type")).toBe(type);
      expect(await resource.text()).toBe(content);
    }
  } finally {
    await window.happyDOM.close();
  }
});

test("a draft gets an automatic stable ID and derives OpenCode settings from its private description", async () => {
  const { admin, store, root } = await fixture();
  const created = await admin(
    request("/personas", {
      ...character,
      draft: await newToken(admin),
      id: "../escape",
      prompt: "injected",
      openingLine: "injected",
      memory: "injected",
    }),
  );
  expect(created.status).toBe(303);
  const id = idOf(created);
  expect(id).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  const persisted = await store.get(id);
  expect(persisted.description).toBe(character.description);
  expect(persisted.prompt).toContain(character.description);
  expect(persisted.prompt).toContain(character.name);
  expect(persisted.prompt).toContain("언어: ko");
  expect(persisted.prompt).not.toContain("injected");
  expect(persisted.openingLine).not.toBe("injected");
  expect(persisted.memory).not.toBe("injected");
  expect(persisted.timeZone).toBe("Asia/Seoul");
  const loaded = await Effect.runPromise(loadPersonas(root));
  expect(loaded.get(id)?.prompt).toBe(persisted.prompt);
  const reopened = createAdmin(await createPersonaStore(root), "test-password", "");
  const page = await (await reopened(request(`/personas/${id}?saved=1`))).text();
  expect(page).toContain(copy.saved);
  expect(page).toContain(`action="/personas/${id}"`);
  expect(page).toContain("독립적인 성격의 도예가");
  const savedAgain = await reopened(
    request(`/personas/${id}`, { ...character, draft: tokenOf(page) }),
  );
  expect(savedAgain.status).toBe(303);
  expect(idOf(savedAgain)).toBe(id);
  expect(await store.list()).toHaveLength(1);
});

test("generation is a private preview until saving; publishing exposes only the approved introduction and image", async () => {
  const { admin, store, root } = await fixture();
  const generated = await admin(
    request("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
  );
  expect(generated.status).toBe(200);
  const page = await generated.text();
  expect(page).not.toContain('class="notice success"');
  expect(page).toContain(introduction);
  expect(page).toContain(copy.regenerate);
  expect(page).toContain(`alt="${character.name} ${copy.styles.anime}"`);
  expect(page).toContain(`alt="${character.name} ${copy.styles.photo}"`);
  const image = /src="(\/images\/[^"]+)"/.exec(page)![1]!;
  expect(await store.list()).toEqual([]);
  expect(await (await admin(new Request("http://localhost:3729/api/personas"))).json()).toEqual([]);
  expect((await store.publicImage(image.slice("/images/".length))).status).toBe(404);
  const privateImage = await admin(request(image));
  expect(privateImage.status).toBe(200);
  expect(privateImage.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await privateImage.arrayBuffer())).toEqual(png);
  const save = await admin(
    request("/personas", {
      ...character,
      draft: tokenOf(page),
      published: "on",
      intent: "save",
    }),
  );
  expect(save.status).toBe(303);
  const id = idOf(save);
  const persisted = await (await createPersonaStore(root)).get(id);
  expect(persisted.portraits?.anime).toBe(`/discovery${image}`);
  expect(persisted.portraits?.photo).toBe(persisted.imageUrl);
  expect((await store.publicImage(image.slice("/images/".length))).status).toBe(200);
  const publicResponse = await admin(new Request("http://localhost:3729/api/personas"));
  expect(publicResponse.headers.get("cache-control")).toBe("no-store");
  const listed = await publicResponse.text();
  expect(JSON.parse(listed)).toEqual([
    {
      id,
      name: character.name,
      bio: introduction,
      imageUrl: persisted.imageUrl,
      portraits: persisted.portraits,
    },
  ]);
  expect(listed).not.toContain("비공개 설정");
  const listPage = await (await admin(request("/"))).text();
  expect(listPage).toContain(`href="/personas/${id}"`);
  expect(listPage).toContain("badge live");
  expect(listPage).toContain(copy.edit);
  expect(listPage).not.toContain(`${id} / EDIT`);
  const editPage = await (await admin(request(`/personas/${id}`))).text();
  expect(editPage).toContain(`alt="${character.name} ${copy.styles.anime}"`);
  expect(editPage).toContain(`src="${image}"`);
  const editedWindow = new Window();
  try {
    editedWindow.document.body.innerHTML = editPage;
    for (const form of editedWindow.document.querySelectorAll("form"))
      expect(form.getAttribute("action")).toBe(`/personas/${id}`);
  } finally {
    await editedWindow.happyDOM.close();
  }
  expect(editPage).toContain("checked");
  expect(editPage).not.toContain('aria-current="page"');
  const withdraw = await admin(
    request(`/personas/${id}`, { ...character, draft: tokenOf(editPage) }),
  );
  expect(withdraw.status).toBe(303);
  expect(await store.publicList()).toEqual([]);
  expect((await store.publicImage(image.slice("/images/".length))).status).toBe(404);
});

test("a failed full image refresh preserves completed photos and can be retried without regenerating the introduction", async () => {
  const portrait = vi
    .fn<ProfileGeneratorPortrait>()
    .mockResolvedValue({ bytes: png, mimeType: "image/png" })
    .mockResolvedValueOnce({ bytes: png, mimeType: "image/png" })
    .mockResolvedValueOnce({ bytes: png, mimeType: "image/png" })
    .mockRejectedValueOnce(new Error("private upstream detail"));
  const intro = vi.fn<typeof generator.introduction>().mockResolvedValue(introduction);
  const { admin, store } = await fixture({ ...generator, portrait, introduction: intro });
  const initial = await (
    await admin(
      request("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
    )
  ).text();
  const token = tokenOf(initial);
  const originalImage = /src="(\/images\/[^"]+)"/.exec(initial)![1]!;
  const failed = await admin(
    request("/personas", { ...character, draft: token, intent: "portrait" }),
  );
  expect(failed.status).toBe(503);
  const page = await failed.text();
  expect(page).toContain(copy.failure);
  expect(page).not.toContain("private upstream detail");
  expect(page).not.toContain(originalImage);
  expect(preview(page).portraits?.anime).toBeUndefined();
  expect(preview(page).portraits?.photo).toBeTruthy();
  expect(page).toContain(introduction);
  expect(page).toContain("독립적인 성격의 도예가");
  const retried = await (
    await admin(request("/personas", { ...character, draft: tokenOf(page), intent: "portrait" }))
  ).text();
  expect(retried).toContain(introduction);
  expect(retried).not.toContain(originalImage);
  expect(intro).toHaveBeenCalledTimes(1);
  expect(portrait).toHaveBeenCalledTimes(6);
  expect(portrait).toHaveBeenCalledWith(femaleCharacter, "anime");
  expect(portrait).toHaveBeenCalledWith(femaleCharacter, "photo");
  expect((await admin(request(originalImage))).status).toBe(200);
  expect(await store.list()).toEqual([]);
});
type ProfileGeneratorPortrait = typeof generator.portrait;

test("legacy IDs and runtime directives stay intact when publishing an unchanged existing character", async () => {
  const { admin, store } = await fixture();
  const imageUrl = "https://example.net/discovery/images/01234567-89ab-cdef-0123-456789abcdef.png";
  await store.create({ ...legacy, imageUrl });
  const page = await (await admin(request("/personas/legacy"))).text();
  expect(page).toContain(legacy.prompt);
  expect(page).toContain(`src="${imageUrl}"`);
  const saved = await admin(
    request("/personas/legacy", {
      name: legacy.name,
      description: legacy.prompt,
      draft: tokenOf(page),
      published: "on",
    }),
  );
  expect(saved.status).toBe(303);
  const next = await store.get("legacy");
  expect(next.id).toBe(legacy.id);
  expect(next.prompt).toBe(legacy.prompt);
  expect(next.openingLine).toBe(legacy.openingLine);
  expect(next.memory).toBe(legacy.memory);
  expect(next.language).toBe(legacy.language);
  expect(next.timeZone).toBe(legacy.timeZone);
  expect(next.description).toBe(legacy.prompt);
});

test("renaming or changing the description of a profile-less draft updates its runtime settings", async () => {
  const { store, admin } = await fixture();
  await store.create({ ...legacy, bio: "", imageUrl: "" });
  for (const changes of [
    { name: "새 이름", description: legacy.prompt },
    { name: "새 이름", description: "  새로운 긴 캐릭터 설정\n비공개 대사 예시  " },
  ]) {
    const token = tokenOf(await (await admin(request("/personas/legacy"))).text());
    const saved = await admin(request("/personas/legacy", { ...changes, draft: token }));
    expect(saved.status).toBe(303);
    const record = await store.get("legacy");
    expect(record.name).toBe(changes.name);
    expect(record.description).toBe(changes.description.trim());
    expect(record.prompt).toContain(`이름: ${changes.name}`);
    expect(record.prompt).toContain(changes.description.trim());
    expect(record.openingLine).not.toBe(legacy.openingLine);
    expect(record.memory).not.toBe(legacy.memory);
  }
  const saved = await admin(
    request("/personas", {
      name: "  하린  ",
      description: `  ${character.description}  `,
      draft: await newToken(admin),
    }),
  );
  const record = await store.get(idOf(saved));
  expect(record.name).toBe("하린");
  expect(record.description).toBe(character.description);
});
