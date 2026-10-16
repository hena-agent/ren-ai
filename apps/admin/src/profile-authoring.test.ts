import { expect, test, vi } from "vitest";
import {
  fixture,
  generator,
  character,
  legacy,
  request,
  tokenOf,
  newToken,
} from "../test/fixtures.ts";
import { createProfileGenerator } from "./generation.ts";
import { modelReply } from "../test/sub-portraits.ts";
import { renderPage } from "./page.tsx";
import { descriptionOf } from "./authoring.ts";
import { versionedPersona, inspectPersona } from "@ren-ai/personas";
import { savedPreview, preview } from "../test/sub-portraits.ts";
import { splitPersonaMarkdown, withPublicProfile } from "@ren-ai/personas/profile";
import { useBrowser } from "../test/browser.ts";

useBrowser();
const profile =
  "천천히 알아가요.\n\n### 내가 편해지는 순간\n조용히 같이 있을 때요.\n\n### 작은 부탁\n답장은 늦어도 괜찮아요.";
const document = withPublicProfile(character.description, profile);

test("the designer has one source input and a safe paragraph preview without block forms", async () => {
  const { admin, store } = await fixture();
  await store.create({ ...legacy, name: character.name, description: document, prompt: document });
  const page = await (await admin(request("/personas/legacy"))).text();
  globalThis.document.body.innerHTML = page;
  expect(globalThis.document.querySelector('[name="profileEditor"]')).toBeNull();
  expect(globalThis.document.querySelector('[name="profile:basics:age"]')).toBeNull();
  expect(globalThis.document.querySelectorAll('[name="description"]')).toHaveLength(1);
  expect(globalThis.document.querySelector("main details")).toBeNull();
  expect(globalThis.document.querySelector('[name="publicBlock"]')).toBeNull();
  expect(globalThis.document.querySelector('[name="publicAddition"]')).toBeNull();
  expect(globalThis.document.querySelector("[data-public-preview]")?.textContent).not.toContain(
    "관심사",
  );
});

test("editing, deleting and adding public Markdown preserve private settings, pictures and intentional omissions", async () => {
  const { admin, store, route, original } = await savedPreview();
  await store.update({ ...original, description: document, prompt: document });
  const page = await (await admin(request(route))).text();
  const description = withPublicProfile(
    document,
    "천천히 알아가요.\n\n### 작은 부탁\n말없이 걸을 때요.\n\n### 같이 해보고 싶은 일\n- 책방 구경\n- 산책",
  );
  const saved = await admin(
    request(route, {
      name: character.name,
      description,
      draft: tokenOf(page),
      published: "on",
    }),
  );
  expect(saved.status).toBe(303);
  const result = await store.get(original.id);
  expect(result.bio).toBe("천천히 알아가요.");
  expect(result.portraits).toEqual(original.portraits);
  expect(result.description).toBe(description);
  expect(result.publicProfile).not.toContain("내가 편해지는 순간");
  expect(result.publicProfile).toContain("말없이 걸을 때요.");
  expect(result.publicProfile).toContain("책방 구경");
  expect(splitPersonaMarkdown(result.description!).privateMarkdown).toBe(
    splitPersonaMarkdown(character.description).privateMarkdown,
  );
  expect(JSON.stringify(await store.publicList())).not.toContain("비공개 설정");
});

test("saving name and private document edits preserves all photos without invoking any generator", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(generator.portrait);
  const convert = vi.fn<typeof generator.convert>();
  const { admin, store, route, original, editing } = await savedPreview({
    ...generator,
    portrait,
    convert,
  });
  portrait.mockClear();
  const name = "수정한 이름";
  const description = original.description
    .replace("짧은 검은 머리", "긴 갈색 머리")
    .replace(`이름: ${original.name}`, `이름: ${name}`);
  expect(description).not.toBe(original.description);
  const updated = `${description}\n\n새롭게 덧붙인 공개 문장입니다.`;
  const response = await admin(
    request(route, {
      name,
      description: updated,
      draft: tokenOf(editing),
      published: "on",
      intent: "save",
    }),
  );
  expect(response.status).toBe(303);
  const saved = await store.get(original.id);
  expect(saved.name).toBe(name);
  expect(saved.description).toBe(updated);
  expect(saved.portraits).toEqual(original.portraits);
  expect(saved.imageUrl).toBe(original.imageUrl);
  expect(saved.published).toBe(true);
  expect(portrait).not.toHaveBeenCalled();
  expect(convert).not.toHaveBeenCalled();
  const reopened = await (await admin(request(route))).text();
  globalThis.document.body.innerHTML = reopened;
  expect(globalThis.document.querySelector<HTMLTextAreaElement>("#description")?.value).toBe(
    updated,
  );
});

test("publishing invalid Markdown preserves source input, diagnostics and saved photos, and obsolete block intents are rejected", async () => {
  const { admin, store, route, original } = await savedPreview();
  const page = await (await admin(request(route))).text();
  for (const description of [
    withPublicProfile(character.description, "### 자기소개 없는 제목"),
    `${character.description}\n\n## 공개 프로필\n중복`,
  ]) {
    const response = await admin(
      request(route, {
        ...character,
        description,
        published: "on",
        draft: tokenOf(page),
        intent: "save",
      }),
    );
    expect(response.status).toBe(400);
    globalThis.document.body.innerHTML = await response.text();
    expect(globalThis.document.querySelector<HTMLTextAreaElement>("#description")?.value).toBe(
      description,
    );
    expect(globalThis.document.querySelector("[data-document-status]")?.textContent).toContain(
      "오류",
    );
  }
  for (const intent of ["profile-add", "profile-edit", "profile-delete"])
    expect(
      (await admin(request(route, { ...character, draft: tokenOf(page), intent }))).status,
    ).toBe(400);
  expect(await store.get(original.id)).toEqual(original);
});

test("public rewriting derives results from the same Markdown document and preserves photos", async () => {
  const rewrite = vi.fn<typeof generator.profile>().mockResolvedValue(profile);
  const { admin, route, editing, original } = await savedPreview({
    ...generator,
    profile: rewrite,
  });
  const response = await admin(
    request(route, { ...character, draft: tokenOf(editing), intent: "profile" }),
  );
  expect(response.status).toBe(200);
  const result = preview(await response.text());
  expect(result.publicProfile).toBe(profile);
  expect(result.bio).toBe("천천히 알아가요.");
  expect(result.portraits).toEqual(original.portraits);
  expect(rewrite).toHaveBeenCalledTimes(1);
});

test("missing required persona section fails at the real save boundary with correlated private-safe diagnostics", async () => {
  const { admin, store, route, original, editing, logs } = await savedPreview();
  const description = withPublicProfile(
    original.description.replace("## 말투", "## 다른 제목"),
    "소개.\n\n### 기본 정보\n- 운영자만-아는-입력",
  );
  const response = await admin(
    request(route, {
      ...character,
      description,
      draft: tokenOf(editing),
      published: "on",
      intent: "save",
    }),
  );
  expect(response.status).toBe(400);
  const requestId = response.headers.get("x-request-id");
  expect(requestId).toBeTruthy();
  const failures = logs.filter(
    (entry) => entry.requestId === requestId && entry.event === "operation.failed",
  );
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({
    level: "warn",
    stage: "persona.save",
    code: "invalid",
    personaId: original.id,
    intent: "save",
  });
  const line = description.slice(0, description.indexOf("## 공개 프로필")).split("\n").length;
  expect(failures[0]?.error?.message).toContain(`${line}행 · 문서 구조:`);
  expect(failures[0]?.error?.message).toContain("필수 섹션을 추가해 주세요: 말투");
  expect(JSON.stringify(failures)).not.toContain("운영자만-아는-입력");
  expect(JSON.stringify(failures)).not.toContain(splitPersonaMarkdown(description).privateMarkdown);
  const html = await response.text();
  expect(html).toContain(`요청 ID: ${requestId}`);
  expect(html).toContain(`${line}행 · 문서 구조:`);
  expect(await store.get(original.id)).toEqual(original);
});

test("intro-only rewriting preserves the persona's custom sections and the native profile writer requests Markdown", async () => {
  const intro = vi.fn<typeof generator.introduction>().mockResolvedValue("안녕하세요.");
  const { admin, store } = await fixture({ ...generator, introduction: intro });
  await store.create({ ...legacy, name: character.name, description: document, prompt: document });
  const page = await (await admin(request("/personas/legacy"))).text();
  const rewritten = await admin(
    request("/personas/legacy", {
      ...character,
      description: document,
      draft: tokenOf(page),
      intent: "introduction",
    }),
  );
  expect(preview(await rewritten.text()).publicProfile).toContain("### 작은 부탁");
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(modelReply(profile));
  const model = createProfileGenerator({ key: "key", fetcher });
  expect(await model.profile(character)).toBe(profile);
  expect(await new Request(...fetcher.mock.calls[0]!).text()).not.toContain("responseMimeType");
});

test("runtime projections can be rendered from the Markdown prompt while incomplete sources are identified", () => {
  const { description: _description, ...runtime } = legacy;
  expect(descriptionOf(runtime)).toBe(legacy.prompt);
  expect(versionedPersona(runtime)).not.toHaveProperty("descriptionVersion");
  expect(inspectPersona(runtime).profileNeeded).toBe(false);
  const page = renderPage({ record: runtime, editing: true, draft: "signed" });
  expect(page).toContain("파리에서 그림을 그려요.");
});

test("incomplete image sources must receive a same-identity complete document before any portrait calls", async () => {
  const convert = vi
    .fn<typeof generator.convert>()
    .mockResolvedValue({ name: "wrong", description: character.description, additions: [] });
  const portrait = vi.fn<typeof generator.portrait>();
  const { admin } = await fixture({ ...generator, convert, portrait });
  const result = await admin(
    request("/personas", {
      name: character.name,
      description: "Private source only",
      draft: await newToken(admin),
      intent: "generate",
    }),
  );
  expect(result.status).toBe(400);
  expect(portrait).not.toHaveBeenCalled();
});
