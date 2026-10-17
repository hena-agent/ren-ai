import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fixture, legacy, request, tokenOf, initialDocuments } from "../test/fixtures.ts";
import { preview } from "../test/sub-portraits.ts";
import { assertSnapshot } from "./snapshot.ts";
import { renderCharacterSheet } from "@ren-ai/personas";
import { withPublicProfile, splitPersonaMarkdown } from "@ren-ai/personas/profile";
import { sheet } from "../test/character.ts";

test("explicit legacy conversion keeps original publication choices, guards stale files and writes one Markdown source", async () => {
  const { admin, store, root } = await fixture();
  const source = `---\n${JSON.stringify({ name: legacy.name, bio: "천천히 알아가요.", description: "Private identity", published: true, "image-url": legacy.imageUrl, "time-zone": legacy.timeZone, language: legacy.language, "opening-line": legacy.openingLine, memory: legacy.memory, gender: "female", "profile-details": { basics: { age: 28 }, lifestyle: { rhythm: "밤형" }, relationship: { contact: "천천히" }, interests: [], answers: [{ question: "하고 싶은 일?", answer: "책방 구경" }] }, portraits: { photo: legacy.imageUrl }, "secondary-portraits": [] })}\n---\nOld prompt duplicate`;
  await writeFile(join(root, "legacy.md"), source);
  await expect(store.get("legacy")).rejects.toThrow("invalid frontmatter");
  const inspection = await (await admin(request("/inspection"))).text();
  expect(inspection).toContain('href="/import/legacy"');
  const response = await admin(request("/import/legacy"));
  expect(response.status).toBe(200);
  const page = await response.text();
  const draft = preview(page);
  expect(draft.publicProfile).not.toContain("관심사");
  expect(draft.publicProfile).toContain("책방 구경");
  expect(draft.imageUrl).toBe(legacy.imageUrl);
  const operatorProfile = draft.publicProfile!.replace(/^- age: 28$/m, "");
  const input = {
    name: draft.name,
    description: withPublicProfile(
      renderCharacterSheet({
        ...sheet,
        name: draft.name,
        appearance: splitPersonaMarkdown(draft.description!).privateMarkdown,
      }),
      operatorProfile,
    ),
    draft: tokenOf(page),
    published: "on",
  };
  await writeFile(join(root, "legacy.md"), `${source}\nExternal edit`);
  expect((await admin(request("/personas/legacy", input))).status).toBe(409);
  await writeFile(join(root, "legacy.md"), source);
  expect((await admin(request("/personas/legacy", input))).status).toBe(303);
  const persisted = await store.source("legacy");
  expect(persisted.split("---")[1]).not.toContain("description:");
  expect(persisted.split("---")[1]).not.toContain("bio:");
  expect(persisted).toContain("## 공개 프로필");
  const exported = await admin(request("/personas/legacy/persona.md"));
  expect(exported.headers.get("content-type")).toContain("text/markdown");
  expect(await exported.text()).toBe(persisted);
  await expect(store.convertLegacy(draft, source)).rejects.toMatchObject({ kind: "conflict" });
  await expect(
    assertSnapshot(store, {
      id: "legacy",
      base: persisted,
      preview: persisted,
      legacySource: source,
    }),
  ).rejects.toMatchObject({ kind: "conflict" });
});
test("legacy inspection distinguishes invalid files from minimal prior descriptions without inventing disclosures", async () => {
  const { admin, store, root } = await fixture();
  const source = `---\n${JSON.stringify({ description: "Private draft", "time-zone": "Asia/Seoul", language: "ko", "opening-line": "Hi", memory: "Keep" })}\n---\nOld body`;
  await writeFile(join(root, "minimal.md"), source);
  const imported = await store.importDraft("minimal");
  expect(imported.persona.name).toBe("minimal");
  expect(imported.persona.bio).toBe("");
  expect((await admin(request("/import/minimal"))).status).toBe(200);
  await expect(store.importDraft("../escape")).rejects.toThrow("ID는");
  const broken = `---\n${JSON.stringify({ "time-zone": "Asia/Seoul", language: "ko", "opening-line": "Hi", memory: "Keep" })}\n---\nOnly current private body`;
  await writeFile(join(root, "notlegacy.md"), broken);
  expect((await admin(request("/import/notlegacy"))).status).toBe(400);
  const earlier = `---\n${JSON.stringify({ bio: "소개", "time-zone": "Asia/Seoul", language: "ko", "opening-line": "Hi", memory: "Keep", "profile-details": { interests: ["산책", "재즈"] } })}\n---\nPrivate body`;
  await writeFile(join(root, "earlier.md"), earlier);
  expect((await store.importDraft("earlier")).persona.publicProfile).toContain("- 재즈");
  await store.create({ ...legacy, id: "withinitial" });
  await store.saveInitial("withinitial", initialDocuments, {
    persona: await store.source("withinitial"),
  });
  await writeFile(join(root, "withinitial.md"), source);
  const withInitial = await admin(request("/import/withinitial"));
  expect(withInitial.status).toBe(200);
  expect(await withInitial.text()).toContain("사진전을 준비 중이다");
});

test("an existing legacy catalog must be explicitly converted before both shared listing and the Admin catalog become usable", async () => {
  const { admin, store, root } = await fixture();
  const metadata = {
    name: legacy.name,
    bio: "기존 공개 소개",
    description: "기존 비공개 인물 설정",
    published: true,
    "image-url": legacy.imageUrl,
    "time-zone": legacy.timeZone,
    language: legacy.language,
    "opening-line": legacy.openingLine,
    memory: legacy.memory,
    portraits: { photo: legacy.imageUrl },
    "secondary-portraits": [{ style: "photo", imageUrl: "https://example.net/secondary.jpg" }],
  };
  for (const id of ["first", "second", "third", "fourth"])
    await writeFile(
      join(root, `${id}.md`),
      `---\n${JSON.stringify(metadata)}\n---\nOld generated prompt`,
    );
  const catalog = () => admin(new Request("http://localhost:3729/api/personas"));
  expect((await catalog()).status).toBe(503);
  await expect(store.publicList()).rejects.toThrow("invalid frontmatter");
  const files = await store.inspect();
  expect(files).toHaveLength(4);
  for (const file of files) {
    if (file.error || !file.legacySource)
      throw new Error("Expected a safe explicit conversion candidate");
    await store.convertLegacy(file.persona, file.legacySource);
  }
  const restored = await catalog();
  expect(restored.status).toBe(200);
  expect(await restored.json()).toMatchObject(
    Array.from({ length: 4 }, () => ({
      name: legacy.name,
      bio: metadata.bio,
      imageUrl: legacy.imageUrl,
      portraits: metadata.portraits,
      secondaryPortraits: metadata["secondary-portraits"],
    })),
  );
  expect(await store.publicList()).toHaveLength(4);
  for (const file of await store.inspect()) {
    if (file.error) throw new Error("Converted files must remain readable");
    expect(file.legacySource).toBeUndefined();
  }
});
