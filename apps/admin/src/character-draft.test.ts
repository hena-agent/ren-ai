import { expect, test, vi } from "vitest";
import {
  fixture,
  generator,
  character,
  authoredCharacter,
  legacy,
  request,
  newToken,
  tokenOf,
} from "../test/fixtures.ts";
import { createProfileGenerator } from "./generation.ts";
import copy from "./copy.json";
import { acceptedReview, characterResponse } from "../test/character.ts";
import { draftTokens } from "./draft.ts";
import { parseInitialState, languageBackground } from "@ren-ai/personas";
import { scores } from "../test/initial.ts";
import { modelReply } from "../test/sub-portraits.ts";

test("a brief idea creates an editable private character draft without saving or publishing it", async () => {
  const drafting = vi.fn<typeof generator.character>().mockResolvedValue(authoredCharacter);
  const { admin, store } = await fixture({ ...generator, character: drafting });
  const response = await admin(
    request("/personas", {
      draft: await newToken(admin),
      seed: "  차분한 도예가, 친해지면 장난기가 많은 사람  ",
      intent: "character",
    }),
  );
  expect(response.status).toBe(200);
  const page = await response.text();
  expect(page).toContain(`value="${character.name}"`);
  expect(page).toContain("독립적인 성격의 도예가");
  expect(draftTokens("test-password").decode(tokenOf(page)).seed).toBe(
    "차분한 도예가, 친해지면 장난기가 많은 사람",
  );
  expect(page).not.toContain('class="seed-form"');
  expect(page).not.toContain('class="notice success"');
  expect(drafting).toHaveBeenCalledWith("차분한 도예가, 친해지면 장난기가 많은 사람", "female");
  expect(await store.list()).toEqual([]);
  const saved = await admin(request("/personas", { ...character, draft: tokenOf(page) }));
  expect(saved.status).toBe(303);
  const record = (await store.list())[0]!;
  expect(record.description).toBe(character.description);
  expect(record.bio).not.toBe("");
  expect(record.imageUrl).toBe("");
  expect(record.portraits).toBeUndefined();
  expect(record.published).toBe(false);
});

test("a draft generation failure preserves the brief idea and the existing character and can be retried", async () => {
  const drafting = vi
    .fn<typeof generator.character>()
    .mockRejectedValueOnce(new Error("provider outage"))
    .mockResolvedValue(authoredCharacter);
  const { admin, store } = await fixture({ ...generator, character: drafting });
  await store.create({ ...legacy, published: true });
  const initial = await (await admin(request("/personas/legacy"))).text();
  const response = await admin(
    request("/personas/legacy", {
      seed: "공방을 운영하는 도예가",
      draft: tokenOf(initial),
      intent: "character",
    }),
  );
  expect(response.status).toBe(503);
  const page = await response.text();
  expect(page).toContain(copy.failure);
  expect(page).toContain("공방을 운영하는 도예가");
  expect(page).toContain(legacy.prompt);
  const retried = await admin(
    request("/personas/legacy", {
      seed: "공방을 운영하는 도예가",
      draft: tokenOf(page),
      intent: "character",
    }),
  );
  expect(retried.status).toBe(200);
  expect(await retried.text()).toContain(character.name);
  expect(await store.get("legacy")).toEqual({ ...legacy, published: true });
  for (const seed of ["", " "])
    expect(
      (
        await admin(
          request("/personas/legacy", { seed, draft: tokenOf(initial), intent: "character" }),
        )
      ).status,
    ).toBe(400);
  const invalidSeed = new FormData();
  invalidSeed.set("draft", tokenOf(initial));
  invalidSeed.set("intent", "character");
  invalidSeed.set("seed", new File(["bad"], "seed.txt"));
  expect(
    (
      await admin(
        new Request("http://localhost:3729/personas/legacy", {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from("admin:test-password").toString("base64")}`,
            Origin: "http://localhost:3729",
          },
          body: invalidSeed,
        }),
      )
    ).status,
  ).toBe(400);
});

test("the AI draft adapter requests the whole Markdown document and validates it before returning it", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(characterResponse())
    .mockResolvedValueOnce(acceptedReview());
  const model = createProfileGenerator({ key: "key", fetcher });
  const drafted = await model.character("혼자 사진을 찍는 하린");
  expect(drafted.name).toBe("하린");
  expect(drafted.description).toContain("## 기본 성향");
  const outgoing = new Request(...fetcher.mock.calls[0]!);
  const body = await outgoing.text();
  expect(body).toContain("혼자 사진을 찍는 하린");
  expect(JSON.parse(body)).toMatchObject({
    generationConfig: {
      maxOutputTokens: 8192,
    },
  });
  expect(body).toContain("responseMimeType");
  for (const text of [
    "invalid JSON",
    "{}",
    '{"name":" ","description":"설명"}',
    '{"name":"이름","description":" "}',
  ]) {
    fetcher.mockResolvedValueOnce(
      Response.json({ candidates: [{ content: { parts: [{ text }] } }] }),
    );
    await expect(model.character("아이디어")).rejects.toThrow("Invalid persona Markdown");
  }
});

test("new drafts carry fixed native background separately from operator-reviewable initial proficiency", async () => {
  const description = character.description.replace(
    "성별: 여성",
    "성별: 여성\n주 사용 언어: ko\n모국어: ko",
  );
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      modelReply(
        JSON.stringify({
          persona: description,
          state: { ...scores, languageProficiency: { ko: "fluent", en: "beginner" } },
          memory: "# 현재 생활\n\n영어를 배우고 있다.",
        }),
      ),
    )
    .mockResolvedValueOnce(acceptedReview());
  const model = createProfileGenerator({ key: "private-key", fetcher });
  const draft = await model.character("영어를 배우는 하린");
  expect(languageBackground(draft.description)).toEqual({ primary: "ko", native: ["ko"] });
  expect(parseInitialState(draft.initial.state).languageProficiency).toEqual({
    ko: "fluent",
    en: "beginner",
  });
});
