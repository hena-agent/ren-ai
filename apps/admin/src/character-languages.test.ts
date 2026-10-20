import { expect, test, vi } from "vitest";
import {
  parseCharacterDescription,
  parseInitialState,
  stateStatus,
  renderCharacterSheet,
} from "@ren-ai/personas";
import { splitPersonaMarkdown } from "@ren-ai/personas/profile";
import { sheet, acceptedReview } from "../test/character.ts";
import { fixture, newToken, request } from "../test/fixtures.ts";
import { modelReply } from "../test/sub-portraits.ts";
import { scores } from "../test/initial.ts";
import { createProfileGenerator } from "./generation.ts";
import { languageDirection } from "./initial-generation.ts";

const seed =
  "Goth Lolita 스타일 미국인 여성. 오타쿠, 집착이 좀 있음. 애정 결핍이 있지만 본성은 나쁘지 않다.";
const english = {
  ...sheet,
  name: "Evelyn Ward",
  languageBackground: { primary: "en-US", native: ["en-US"] },
  speech: "Informal English, a little intense when excited about shared interests.",
  samples: ["Hey, did you finish that series?", "Okay but that dress is everything."],
};
const publicProfile = "Usually overdressed for the bookstore. Tell me your most niche obsession.";
const packet = (persona = english, levels = { en: "fluent", ja: "beginner" }) =>
  modelReply(
    JSON.stringify({
      persona,
      publicProfile,
      state: { ...scores, languageProficiency: levels },
      memory: "# 현재 생활\n\n- 주말 독서 모임을 준비한다.",
    }),
  );

test("a Korean idea preserves an English identity and public voice with canonical language fields", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(packet())
    .mockResolvedValueOnce(acceptedReview());
  const result = await createProfileGenerator({ key: "key", fetcher }).character(seed, "female");
  expect(result.name).toBe(english.name);
  const character = parseCharacterDescription(result.description);
  expect(character.languageBackground).toEqual({ primary: "en", native: ["en"] });
  expect(character.samples).toEqual(english.samples);
  expect(splitPersonaMarkdown(result.description).publicMarkdown).toBe(publicProfile);
  expect(result.description).toContain("주 사용 언어: en\n모국어: en\n\n");
  expect(stateStatus(result.initial.state, result.description).state).toBe("valid");
  for (const call of fetcher.mock.calls)
    expect(await new Request(...call).text()).toContain(languageDirection);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("deterministic language checks require repair even if the model review misses the mismatch, without promoting a learned language", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      packet({ ...english, languageBackground: { primary: "en-US", native: ["en-US", "ja"] } }),
    )
    .mockResolvedValueOnce(acceptedReview())
    .mockResolvedValueOnce(packet())
    .mockResolvedValueOnce(acceptedReview());
  const result = await createProfileGenerator({ key: "key", fetcher }).character(seed);
  expect(parseCharacterDescription(result.description).languageBackground?.native).toEqual(["en"]);
  expect(parseInitialState(result.initial.state).languageProficiency).toEqual({
    en: "fluent",
    ja: "beginner",
  });
  const repair = await new Request(...fetcher.mock.calls[2]!).text();
  expect(repair).toContain("모국어 ja");
  expect(repair).toContain("beginner");
  expect(repair).toContain(languageDirection);
  expect(fetcher).toHaveBeenCalledTimes(4);
});

test("a language mismatch surviving repair fails at the real authoring boundary without publishing or leaking the draft", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(packet(english, { en: "beginner", ja: "beginner" }))
    .mockResolvedValueOnce(acceptedReview())
    .mockResolvedValueOnce(packet(english, { en: "beginner", ja: "beginner" }))
    .mockResolvedValueOnce(acceptedReview());
  const { admin, store, logs } = await fixture(
    createProfileGenerator({ key: "private-key", fetcher }),
  );
  const response = await admin(
    request("/personas", { draft: await newToken(admin), seed, intent: "character" }),
  );
  expect(response.status).toBe(503);
  expect(await store.list()).toEqual([]);
  expect(logs.find((entry) => entry.event === "operation.failed")).toMatchObject({
    requestId: response.headers.get("X-Request-ID"),
    stage: "character.review",
    code: "character_review_failed",
  });
  for (const secret of [seed, english.name, publicProfile, "private-key"])
    expect(JSON.stringify(logs)).not.toContain(secret);
});

test.each([
  { levels: { en: "beginner" }, label: "nonfluent native" },
  { levels: { ko: "fluent" }, label: "missing primary" },
])(
  "individual State generation rejects $label instead of returning an invalid proposal",
  async ({ levels }) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        modelReply(JSON.stringify({ ...scores, languageProficiency: levels })),
      );
    await expect(
      createProfileGenerator({ key: "key", fetcher }).state({
        name: english.name,
        description: renderCharacterSheet(english),
      }),
    ).rejects.toMatchObject({ fields: { code: "invalid_initial_document" } });
  },
);
