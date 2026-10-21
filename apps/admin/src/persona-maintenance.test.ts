import { expect, test, vi } from "vitest";
import { seedSheets } from "../test/fixtures.ts";
import { fixture, generator, legacy, request, tokenOf } from "../test/fixtures.ts";
import { preview } from "../test/sub-portraits.ts";
import { sheet, characterResponse, acceptedReview } from "../test/character.ts";
import { renderCharacterSheet } from "@ren-ai/personas";
import { createProfileGenerator } from "./generation.ts";
import { decodePersona } from "@ren-ai/personas";
import { modelReply } from "../test/sub-portraits.ts";
import { withPublicProfile } from "@ren-ai/personas/profile";

const description = withPublicProfile(renderCharacterSheet(sheet), legacy.bio);
const original = decodePersona({
  ...legacy,
  name: sheet.name,
  gender: "female" as const,
  description: withPublicProfile(
    `## 정체성·외형\n\n이름: ${sheet.name}\n성별: 여성\n생년월일: ${sheet.birthDate}\n\n혼자 사진을 찍는 하린. 말수가 적고 자기 시간을 소중히 여긴다.`,
    legacy.bio,
  ),
  published: true,
});
const fields = { name: original.name, description: original.description!, published: "on" };
const conversion = {
  name: sheet.name,
  description,
  additions: ["말투 예시와 기본 성향 수치를 보강했습니다."],
};

async function prepareConversion(convert: typeof generator.convert) {
  const result = await fixture({ ...generator, convert });
  await result.store.create(original);
  const page = await (await result.admin(request("/personas/legacy"))).text();
  return { ...result, input: { ...fields, draft: tokenOf(page), intent: "improve" } };
}

const convertPage = async (
  admin: Awaited<ReturnType<typeof fixture>>["admin"],
  page: string,
  source: string,
) => {
  return admin(
    request("/personas/legacy", {
      ...fields,
      description: source,
      draft: tokenOf(page),
      intent: "improve",
    }),
  );
};

test("the retired inspection page is absent from navigation and returns not found", async () => {
  const { admin } = await fixture();
  const page = await (await admin(request("/"))).text();
  expect(page).not.toContain('href="/inspection"');
  expect(page).not.toContain("전체 검사");
  expect((await admin(request("/inspection"))).status).toBe(404);
});

test("conversion can be saved immediately with existing photos and public state, with regeneration independently selected", async () => {
  const convert = vi.fn<typeof generator.convert>().mockResolvedValue(conversion);
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(generator.portrait);
  const { admin, store } = await fixture({ ...generator, convert, portrait });
  await store.create(original);
  const initial = await (await admin(request("/personas/legacy"))).text();
  const inspected = await admin(
    request("/personas/legacy", { ...fields, draft: tokenOf(initial), intent: "inspect" }),
  );
  expect(inspected.status).toBe(200);
  expect(convert).not.toHaveBeenCalled();
  const proposal = await admin(
    request("/personas/legacy", { ...fields, draft: tokenOf(initial), intent: "improve" }),
  );
  expect(proposal.status).toBe(200);
  const page = await proposal.text();
  expect(page).toContain(conversion.additions[0]);
  expect(page).not.toContain("변환 전 설명");
  const draft = preview(page);
  expect(draft.description).toBe(description);
  expect(draft.imageUrl).toBe(original.imageUrl);
  expect(draft.bio).toBe(original.bio);
  expect(draft.published).toBe(true);
  expect(draft.prompt).toContain(description);
  expect(await store.get("legacy")).toEqual(original);
  const refreshed = await (await admin(request("/personas/legacy"))).text();
  expect(preview(refreshed).description).toBe(description);
  expect(refreshed).toContain("data-improvement-source");
  const directSave = await admin(
    request("/personas/legacy", { ...fields, description, draft: tokenOf(page), intent: "save" }),
  );
  expect(directSave.status).toBe(303);
  expect((await store.get("legacy")).imageUrl).toBe(original.imageUrl);
  expect((await store.get("legacy")).published).toBe(true);
  expect(portrait).not.toHaveBeenCalled();
  await seedSheets(store, original.id);
  const savedPage = await (await admin(request("/personas/legacy"))).text();
  const generated = await admin(
    request("/personas/legacy", {
      ...fields,
      description,
      draft: tokenOf(savedPage),
      intent: "generate",
    }),
  );
  expect(generated.status).toBe(200);
  const regenerated = await generated.text();
  const saved = await admin(
    request("/personas/legacy", { ...fields, description, draft: tokenOf(regenerated) }),
  );
  expect(saved.status).toBe(303);
  expect((await store.get("legacy")).descriptionVersion).toBe(2);
  expect((await store.get("legacy")).publicProfile).toBeTruthy();
  expect(portrait).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(await store.publicList())).not.toContain("additions");
});

test("already structured descriptions can be improved without requiring paid image work", async () => {
  const convert = vi.fn<typeof generator.convert>().mockResolvedValue(conversion);
  const { admin, store } = await fixture({ ...generator, convert });
  const record = { ...original, description };
  await store.create(record);
  const page = await (await admin(request("/personas/legacy"))).text();
  expect(page).toContain('value="improve"');
  const response = await convertPage(admin, page, description);
  const normalized = await response.text();
  expect(response.status).toBe(200);
  expect(normalized).not.toContain("conversion-report");
  expect(normalized).not.toContain("변환 전 설명");
  expect(convert).toHaveBeenCalledTimes(1);
  expect(
    (
      await admin(
        request("/personas/legacy", { ...fields, description, draft: tokenOf(normalized) }),
      )
    ).status,
  ).toBe(303);
  expect((await store.get("legacy")).descriptionVersion).toBe(2);
});

test("conversion retains public edits submitted in the same form without treating version-only changes as new settings", async () => {
  const convert = vi.fn<typeof generator.convert>().mockResolvedValue(conversion);
  const { admin, store } = await fixture({ ...generator, convert });
  await store.create({ ...original, description });
  const page = await (await admin(request("/personas/legacy"))).text();
  const result = await convertPage(admin, page, description);
  expect(result.status).toBe(200);
  expect(preview(await result.text()).description).toBe(description);
});

test("a structured description with conflicting identity is repaired from the saved persona binding", async () => {
  const convert = vi.fn<typeof generator.convert>().mockResolvedValue(conversion);
  const { admin, store } = await fixture({ ...generator, convert });
  for (const candidate of [
    { ...sheet, name: "다른 이름" },
    { ...sheet, gender: "male" as const },
  ]) {
    const source = withPublicProfile(renderCharacterSheet(candidate), original.bio);
    if ((await store.list()).length) await store.update({ ...original, description: source });
    else await store.create({ ...original, description: source });
    const page = await (await admin(request("/personas/legacy"))).text();
    const result = await convertPage(admin, page, source);
    expect(result.status).toBe(200);
    expect(preview(await result.text()).description).toBe(description);
  }
  expect(convert).toHaveBeenCalledTimes(2);
});

test("bad conversion output, changed identity and stale source preserve the original", async () => {
  const convert = vi
    .fn<typeof generator.convert>()
    .mockResolvedValueOnce({ ...conversion, name: "changed" })
    .mockResolvedValueOnce({ ...conversion, description: "broken" });
  const { admin, store, input } = await prepareConversion(convert);
  for (let index = 0; index < 2; index++)
    expect((await admin(request("/personas/legacy", input))).status).toBe(503);
  convert.mockResolvedValueOnce(conversion);
  expect((await admin(request("/personas/legacy", { ...input, name: "edited" }))).status).toBe(503);
  expect(await store.get("legacy")).toEqual(original);
  await store.update({
    ...original,
    description: withPublicProfile(original.description!, "다른 탭의 새 소개"),
  });
  expect((await admin(request("/personas/legacy", input))).status).toBe(409);
});

test("converted sheet identity is validated even when an adapter returns the expected outer name", async () => {
  const convert = vi
    .fn<typeof generator.convert>()
    .mockResolvedValueOnce({
      ...conversion,
      description: renderCharacterSheet({ ...sheet, name: "different" }),
    })
    .mockResolvedValueOnce({
      ...conversion,
      description: renderCharacterSheet({ ...sheet, gender: "male" }),
    })
    .mockResolvedValueOnce(conversion);
  const { admin, store, input } = await prepareConversion(convert);
  expect((await admin(request("/personas/legacy", input))).status).toBe(503);
  expect((await admin(request("/personas/legacy", input))).status).toBe(503);
  const { gender: _gender, ...unselected } = { ...original, published: false };
  await store.update(unselected);
  const next = await (await admin(request("/personas/legacy"))).text();
  const response = await admin(
    request("/personas/legacy", {
      ...fields,
      published: "",
      draft: tokenOf(next),
      intent: "improve",
    }),
  );
  expect(response.status).toBe(200);
  const converted = await response.text();
  convert.mockResolvedValueOnce(conversion);
  const repeated = await admin(
    request("/personas/legacy", {
      ...fields,
      description,
      published: "",
      draft: tokenOf(converted),
      intent: "improve",
    }),
  );
  expect(repeated.status).toBe(200);
  expect(
    (
      await admin(
        request("/personas/legacy", {
          ...fields,
          description,
          draft: tokenOf(await repeated.text()),
          intent: "save",
        }),
      )
    ).status,
  ).toBe(303);
});

test("conversion uses the real structured-generation and review boundary with exact identity and a private supplement report", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      modelReply(JSON.stringify({ persona: sheet, publicProfile: legacy.bio })),
    )
    .mockResolvedValueOnce(characterResponse({ issues: [], additions: conversion.additions }));
  const model = createProfileGenerator({ key: "key", fetcher });
  expect(
    await model.convert(
      { name: sheet.name, description: original.description!, gender: "female" },
      "주말 생활을 보강해 줘.",
    ),
  ).toEqual(conversion);
  expect(await new Request(...fetcher.mock.calls[0]!).text()).toContain("SAVED NAME: 하린");
  for (const call of fetcher.mock.calls) {
    const body = await new Request(...call).text();
    expect(body).toContain("주말 생활을 보강해 줘.");
    expect(body).toContain("문답: 완벽한 일요일은?");
  }
  const wrong = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(characterResponse({ ...sheet, name: "changed" }, true));
  await expect(
    createProfileGenerator({ key: "key", fetcher: wrong }).convert({
      name: sheet.name,
      description: original.description!,
    }),
  ).rejects.toMatchObject({ fields: { code: "character_name_mismatch" } });
});

test("conversion repair retains the Persona-only response contract and never regenerates initial siblings", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(characterResponse(sheet, true))
    .mockResolvedValueOnce(characterResponse({ issues: ["repair the source"] }))
    .mockResolvedValueOnce(characterResponse(sheet, true))
    .mockResolvedValueOnce(acceptedReview());
  const result = await createProfileGenerator({ key: "key", fetcher }).convert({
    name: sheet.name,
    description: original.description!,
  });
  expect(result.description).toContain("## 정체성·외형");
  expect(result).not.toHaveProperty("initial");
  expect(fetcher).toHaveBeenCalledTimes(4);
});
