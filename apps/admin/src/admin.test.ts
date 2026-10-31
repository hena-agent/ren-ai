import { createPersonaStore, loadPersonas } from "@ren-ai/personas";
import { Effect } from "effect";
import { Window } from "happy-dom";
import type { HTMLInputElement, HTMLTextAreaElement, HTMLMetaElement } from "happy-dom";
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
import { ageOn } from "@ren-ai/personas/birth-date";
import { thumbnailUrl } from "@ren-ai/personas/image-url";
import { sheet } from "../test/character.ts";

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
    expect(emptyPage).toContain('href="/" aria-current="page"');
    expect(emptyPage).toContain('class="admin-sidebar"');
    expect(emptyPage).toContain('href="/seeding">시딩</a>');
    const editorResponse = await admin(request("/new"));
    const page = await editorResponse.text();
    expect(page).toContain('href="/new" aria-current="page"');
    expect(page).toMatch(/^<!doctype html>/);
    window.document.write(page);
    const nonce = window.document.querySelector<HTMLMetaElement>(
      'meta[name="style-nonce"]',
    )!.content;
    expect(nonce).not.toBe("");
    expect(editorResponse.headers.get("content-security-policy")).toContain(`'nonce-${nonce}'`);
    expect(editorResponse.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(window.document.title).toBe("RenAI / Admin");
    expect(window.document.querySelector("form")?.getAttribute("action")).toBe("/personas");
    expect(window.document.querySelector("#persona-editor")?.getAttribute("action")).toBe(
      "/personas",
    );
    expect(window.document.querySelector("form")?.getAttribute("method")).toBe("post");
    for (const name of [
      "id",
      "imageUrl",
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
    expect(description.getAttribute("wrap")).not.toBe("off");
    expect(description.required).toBe(true);
    expect(description.getAttribute("aria-describedby")).toBe("document-issues");
    expect(
      [...window.document.querySelectorAll("label")].map((label) => label.textContent?.trim()),
    ).toEqual(expect.arrayContaining(["성별 선택", "간단한 설명", "프로필 공개"]));
    expect(window.document.querySelector('[name="bio"]')).toBeNull();
    expect(window.document.querySelector(".persona-document-editor")?.tagName).toBe("SECTION");
    expect(window.document.querySelector("main details")).toBeNull();
    for (const label of window.document.querySelectorAll("label"))
      expect(window.document.getElementById(label.getAttribute("for")!)).not.toBeNull();
    expect(window.document.querySelector<HTMLInputElement>("#published")?.checked).toBe(false);
    expect(window.document.querySelector('[value="portrait"]')).toBeNull();
    expect(window.document.querySelector("[data-pending]")).not.toBeNull();
    expect(window.document.querySelector("script")?.getAttribute("src")).toBe(
      "/assets/admin-test.js",
    );
    expect(window.document.querySelector("script")?.getAttribute("type")).toBe("module");
    expect(window.document.querySelector('link[rel="stylesheet"]')?.getAttribute("href")).toBe(
      "/assets/admin-test.css",
    );
    expect(window.document.querySelector("aside #preview-title")?.textContent).toBe("프로필 사진");
    expect(window.document.querySelector(".editor-name")?.textContent).toBe(copy.new);
    expect(
      [...window.document.querySelectorAll(".portrait-empty")].map((entry) => entry.textContent),
    ).toEqual(["아직 실사 사진이 없습니다.", "아직 애니풍 사진이 없습니다."]);
    expect(window.document.querySelectorAll(".portrait-count")).toHaveLength(2);
    expect(window.document.querySelector('[value="subportrait"]')).toBeNull();
    expect(window.document.querySelector('[role="alert"]')).toBeNull();
    expect(window.document.querySelector(".notice.success")).toBeNull();
    expect(tokenOf(page)).not.toBe("");
    for (const route of ["/style.css", "/pending.js"])
      expect((await admin(request(route))).status).toBe(404);
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
  expect(persisted.prompt).toBe(character.description);
  expect(persisted.prompt).not.toContain("injected");
  expect(persisted.openingLine).not.toBe("injected");
  expect(persisted.memory).not.toBe("injected");
  expect(persisted.timeZone).toBe("Asia/Seoul");
  const loaded = await Effect.runPromise(loadPersonas(root));
  expect(loaded.get(id)?.prompt).toBe(persisted.prompt);
  const reopened = createAdmin(await createPersonaStore(root), "test-password");
  const page = await (await reopened(request(`/personas/${id}?saved=1`))).text();
  expect(page).toContain(copy.saved);
  expect(page).toContain(`action="/personas/${id}"`);
  expect(page).not.toContain('class="seed-form"');
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
  expect(page).not.toContain("전체 사진 다시 생성");
  expect(page).toContain(`alt="${character.name} ${copy.styles.photo} · 사진 1"`);
  const image = preview(page).portraits!.photo!;
  expect(await store.list()).toEqual([]);
  expect(await (await admin(new Request("http://localhost:3729/api/personas"))).json()).toEqual([]);
  expect((await store.image(image.slice("/images/".length))).status).toBe(200);
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
  expect(persisted.portraits?.photo).toBe(image);
  expect(persisted.portraits?.photo).toBe(persisted.imageUrl);
  expect((await store.image(image.slice("/images/".length))).status).toBe(200);
  const publicResponse = await admin(new Request("http://localhost:3729/api/personas"));
  expect(publicResponse.headers.get("cache-control")).toBe("no-store");
  const listed = await publicResponse.text();
  expect(JSON.parse(listed)).toEqual([
    {
      id,
      name: character.name,
      age: ageOn(sheet.birthDate),
      bio: introduction,
      imageUrl: persisted.imageUrl,
      portraits: persisted.portraits,
      secondaryPortraits: [],
      profile: { introduction, sections: [] },
    },
  ]);
  expect(listed).not.toContain("비공개 설정");
  const listPage = await (await admin(request("/"))).text();
  expect(listPage).toContain(`href="/personas/${id}"`);
  expect(listPage).toContain("badge live");
  expect(listPage).toContain(copy.edit);
  expect(listPage).not.toContain(`${id} / EDIT`);
  const editPage = await (await admin(request(`/personas/${id}`))).text();
  expect(editPage).toContain(`alt="${character.name} ${copy.styles.photo} · 사진 1"`);
  expect(editPage).toContain(`src="${thumbnailUrl(image)}"`);
  expect(editPage).toContain(`href="${image}"`);
  const editedWindow = new Window();
  try {
    editedWindow.document.body.innerHTML = editPage;
    for (const form of editedWindow.document.querySelectorAll("form"))
      expect(form.getAttribute("action")).toBe(`/personas/${id}`);
  } finally {
    await editedWindow.happyDOM.close();
  }
  expect(editPage).toContain("checked");
  expect(editPage).toContain('href="/" aria-current="page"');
  const withdraw = await admin(
    request(`/personas/${id}`, { ...character, draft: tokenOf(editPage) }),
  );
  expect(withdraw.status).toBe(303);
  expect(await store.publicList()).toEqual([]);
  expect((await store.image(image.slice("/images/".length))).status).toBe(200);
});

test("a failed photo addition preserves completed photos and retry does not regenerate the introduction", async () => {
  const portrait = vi
    .fn<ProfileGeneratorPortrait>()
    .mockResolvedValue({ bytes: png, mimeType: "image/png" })
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
  const originalImage = preview(initial).portraits!.photo!;
  const failed = await admin(
    request("/personas", { ...character, draft: token, intent: "generate" }),
  );
  expect(failed.status).toBe(503);
  const page = await failed.text();
  expect(page).toContain(copy.failure);
  expect(page).not.toContain("private upstream detail");
  expect(page).toContain(originalImage);
  expect(preview(page).portraits?.anime).toBeUndefined();
  expect(preview(page).portraits?.photo).toBeTruthy();
  expect(page).toContain(introduction);
  expect(page).toContain("독립적인 성격의 도예가");
  const retried = await (
    await admin(request("/personas", { ...character, draft: tokenOf(page), intent: "generate" }))
  ).text();
  expect(retried).toContain(introduction);
  expect(retried).toContain(originalImage);
  expect(intro).not.toHaveBeenCalled();
  expect(portrait).toHaveBeenCalledTimes(3);
  expect(portrait).toHaveBeenCalledWith(
    femaleCharacter,
    "photo",
    "",
    expect.objectContaining({ mimeType: "image/jpeg" }),
  );
  expect((await admin(request(originalImage))).status).toBe(200);
  expect(await store.list()).toEqual([]);
});
type ProfileGeneratorPortrait = typeof generator.portrait;

test("legacy IDs and runtime directives stay intact in a private save while incomplete publication is blocked", async () => {
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
  expect(saved.status).toBe(400);
  expect(
    (
      await admin(
        request("/personas/legacy", {
          name: legacy.name,
          description: legacy.prompt,
          draft: tokenOf(page),
        }),
      )
    ).status,
  ).toBe(303);
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
  await store.create({
    ...legacy,
    description: "You are Mira, a painter in Paris.",
    bio: "",
    imageUrl: "",
  });
  for (const changes of [
    { name: "새 이름", description: "You are Mira, a painter in Paris." },
    { name: "새 이름", description: "  새로운 긴 캐릭터 설정\n비공개 대사 예시  " },
  ]) {
    const token = tokenOf(await (await admin(request("/personas/legacy"))).text());
    const saved = await admin(request("/personas/legacy", { ...changes, draft: token }));
    expect(saved.status).toBe(303);
    const record = await store.get("legacy");
    expect(record.name).toBe(changes.name);
    expect(record.description).toBe(changes.description.trim());
    expect(record.prompt).toBe(changes.description.trim());
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
