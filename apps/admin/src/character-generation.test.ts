import { expect, test, vi } from "vitest";
import { createProfileGenerator } from "./generation.ts";
import { sheet, acceptedReview, characterResponse } from "../test/character.ts";
import { fixture, generator, legacy, newToken, request, tokenOf } from "../test/fixtures.ts";
import { preview, modelReply } from "../test/sub-portraits.ts";
import { renderCharacterSheet } from "@ren-ai/personas";
import { withPublicProfile } from "@ren-ai/personas/profile";
import policy from "./character-policy.json";
import type { LogEntry } from "./logging.ts";
import { parseInitialState } from "@ren-ai/personas";
import initialPolicy from "./initial-policy.json";
import { birthDateOf } from "@ren-ai/personas/birth-date";

function failureOf(logs: readonly LogEntry[], response: Response) {
  const failures = logs.filter((entry) => entry.event === "operation.failed");
  expect(failures).toHaveLength(1);
  const failure = failures[0]!;
  expect(failure.requestId).toBe(response.headers.get("X-Request-ID"));
  expect(failure.model).toBe("gemini-3.8-flash");
  return failure;
}

test("the real authoring boundary saves only a reviewed, editable persona description", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(characterResponse())
    .mockResolvedValueOnce(acceptedReview());
  const { admin, store, logs } = await fixture(
    createProfileGenerator({ key: "private-key", fetcher }),
  );
  const seed = "독립적인 사진가 하린, 짧고 건조한 존댓말";
  const response = await admin(
    request("/personas", {
      draft: await newToken(admin),
      seed,
      intent: "character",
    }),
  );
  expect(response.status).toBe(200);
  const page = await response.text();
  const result = preview(page);
  const description = result.description!;
  expect(description).toContain("자율성: 85");
  expect(description).toContain("나타나는 상황: 일이 막힐 때");
  expect(description).toContain(sheet.contactExpectation);
  expect(description).toContain(sheet.samples[2]);
  expect(description).toContain("성별: 여성");
  for (const field of [
    "성장 배경",
    "생활·목표",
    "가치관",
    "취향",
    "습관",
    "선호·경계",
    "관계관",
    "말투",
  ])
    expect(description).toContain(`## ${field}`);
  expect(await store.list()).toEqual([]);
  const saved = await admin(
    request("/personas", {
      draft: tokenOf(page),
      name: result.name,
      description,
    }),
  );
  expect(saved.status).toBe(303);
  const persona = await store.get(result.id);
  expect(persona.description).toBe(description);
  expect(persona.prompt).toContain(description);
  for (const privateProcess of [
    policy.generate,
    policy.review,
    policy.reference,
    "CANDIDATE",
    "issues",
    "STATE.md",
    "MEMORY.md",
  ])
    expect(persona.prompt).not.toContain(privateProcess);
  expect(persona).not.toHaveProperty("base");
  expect(await new Request(...fetcher.mock.calls[0]!).text()).toContain("responseJsonSchema");
  expect((await store.initial(result.id))?.memory).toContain("사진전을 준비 중");
  expect(parseInitialState((await store.initial(result.id))!.state).affection).toBe(18);
  expect(await new Request(...fetcher.mock.calls[0]!).text()).toContain(initialPolicy.affection);
  expect(await new Request(...fetcher.mock.calls[1]!).text()).toContain(initialPolicy.affection);
  expect(await new Request(...fetcher.mock.calls[1]!).text()).toContain(seed);
  const generationRequest = await new Request(...fetcher.mock.calls[0]!).text();
  expect(generationRequest).toContain(`오늘 UTC 날짜: ${new Date().toISOString().slice(0, 10)}`);
  expect(generationRequest).not.toContain("{{CURRENT_DATE_UTC}}");
  expect(birthDateOf(description)).toBe(sheet.birthDate);
  expect(
    logs.filter((entry) => entry.event === "operation.completed").map((entry) => entry.stage),
  ).toEqual(expect.arrayContaining(["character.draft", "character.review", "character.generate"]));
  const diagnostics = JSON.stringify(logs);
  for (const secret of ["private-key", seed, sheet.appearance, sheet.hidden[0]!.reason])
    expect(diagnostics).not.toContain(secret);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("one targeted repair is reviewed again and only the corrected sheet becomes the draft", async () => {
  const issue = "말투가 원본과 달리 상담원처럼 장황하다.";
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(characterResponse({ ...sheet, speech: "장황한 상담원 말투" }))
    .mockResolvedValueOnce(characterResponse({ issues: [issue] }))
    .mockResolvedValueOnce(characterResponse())
    .mockResolvedValueOnce(acceptedReview());
  const { admin, logs } = await fixture(createProfileGenerator({ key: "key", fetcher }));
  const response = await admin(
    request("/personas", {
      draft: await newToken(admin),
      seed: "짧고 건조하게 말하는 하린",
      intent: "character",
    }),
  );
  expect(response.status).toBe(200);
  const result = preview(await response.text());
  expect(result.description).toContain(sheet.speech);
  expect(result.description).not.toContain(issue);
  expect(result.description).not.toContain("장황한 상담원 말투");
  const repair = await new Request(...fetcher.mock.calls[2]!).text();
  expect(repair).toContain(policy.repair);
  expect(repair).toContain(issue);
  expect(repair).toContain("SELECTED GENDER: female");
  expect(await new Request(...fetcher.mock.calls[3]!).text()).toContain(sheet.speech);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(
    logs.some(
      (entry) => entry.stage === "character.repair" && entry.event === "operation.completed",
    ),
  ).toBe(true);
});

test.each<{ invalid: object; label: string; output?: string }>([
  { invalid: { ...sheet, base: {} }, label: "missing axes" },
  {
    invalid: {},
    output: withPublicProfile(
      `${renderCharacterSheet(sheet)}\n\n## MEMORY\nInvented shared memory`,
      "안녕하세요.",
    ),
    label: "runtime memory",
  },
  { invalid: { ...sheet, name: " " }, label: "empty name" },
  { invalid: { ...sheet, speech: "x".repeat(2001) }, label: "oversized field" },
  { invalid: { ...sheet, samples: ["한 문장"] }, label: "insufficient samples" },
  {
    invalid: { ...sheet, hidden: Array.from({ length: 7 }, () => sheet.hidden[0]) },
    label: "too many traits",
  },
  ...[-1, 101, 12.5].map((value) => ({
    invalid: { ...sheet, base: { ...sheet.base, autonomy: { ...sheet.base.autonomy, value } } },
    label: `invalid score ${value}`,
  })),
])("invalid persona output is rejected before review: $label", async ({ invalid, output }) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(output ? modelReply(output) : characterResponse(invalid));
  const { admin, store, logs } = await fixture(createProfileGenerator({ key: "key", fetcher }));
  const response = await admin(
    request("/personas", {
      draft: await newToken(admin),
      seed: "원본 아이디어",
      intent: "character",
    }),
  );
  expect(response.status).toBe(503);
  expect(await store.list()).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(logs.find((entry) => entry.event === "operation.failed")).toMatchObject({
    stage: "character.draft",
    code: "invalid_character",
    model: "gemini-3.8-flash",
  });
});

test("male personas with no hidden traits and endpoint scores retain their own identity", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      characterResponse({
        ...sheet,
        gender: "male",
        name: "지우",
        hidden: [],
        base: {
          ...sheet.base,
          autonomy: { value: 0, reason: "함께 결정하기 편하다." },
          expression: { value: 100, reason: "감정을 잘 표현한다." },
        },
        samples: ["앗 안녕하세요 ㅎㅎ", "헐 진짜요?ㅋㅋ"],
      }),
    )
    .mockResolvedValueOnce(acceptedReview());
  const model = createProfileGenerator({ key: "key", fetcher });
  const result = await model.character("사람을 잘 챙기는 지우", "male");
  expect(result.name).toBe("지우");
  expect(result.description).toContain("성별: 남성");
  expect(result.description).toContain("별도로 정의한 숨겨진 특성 없음.");
  expect(result.description).toContain("자율성: 0");
  expect(result.description).toContain("감정 표현성: 100");
});

test("reviewed improvements cannot change the existing birth date", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(characterResponse({ ...sheet, birthDate: "1999-04-12" }, true));
  const model = createProfileGenerator({ key: "key", fetcher });
  const source = withPublicProfile(renderCharacterSheet(sheet), "천천히 알아가는 쪽이 편해요.");
  await expect(model.convert({ name: sheet.name, description: source })).rejects.toMatchObject({
    fields: { code: "character_birth_date_mismatch" },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each(["missing", "invalid"])(
  "the real generation and review boundary completes an %s birthday",
  async (kind) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(characterResponse(sheet, true))
      .mockResolvedValueOnce(acceptedReview());
    const source = withPublicProfile(renderCharacterSheet(sheet), "천천히 알아가요.");
    const description =
      kind === "missing"
        ? source.replace(/^생년월일: .*\n/m, "")
        : source.replace(sheet.birthDate, "1998-02-30");
    const result = await createProfileGenerator({ key: "key", fetcher }).convert({
      name: sheet.name,
      description,
    });
    expect(birthDateOf(result.description)).toBe(sheet.birthDate);
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

test.each([
  {
    replies: [{ ...sheet, gender: "male" }],
    stage: "character.draft",
    code: "character_gender_mismatch",
  },
  { replies: [sheet, {}], stage: "character.review", code: "invalid_character_review" },
  {
    replies: [sheet, { issues: ["private finding"] }, {}],
    stage: "character.repair",
    code: "invalid_character",
  },
  {
    replies: [sheet, { issues: ["private finding"] }, { ...sheet, gender: "male" }],
    stage: "character.repair",
    code: "character_gender_mismatch",
  },
  {
    replies: [
      sheet,
      { issues: ["private finding"] },
      sheet,
      { issues: ["private remaining finding"] },
    ],
    stage: "character.review",
    code: "character_review_failed",
  },
])(
  "$code at $stage preserves the saved persona and correlates safe diagnostics",
  async ({ replies, stage, code }) => {
    const fetcher = vi.fn<typeof fetch>();
    for (const reply of replies) fetcher.mockResolvedValueOnce(characterResponse(reply));
    const { admin, store, logs } = await fixture(
      createProfileGenerator({ key: "private-key", fetcher }),
    );
    await store.create({ ...legacy, gender: "female" });
    const initial = await (await admin(request("/personas/legacy"))).text();
    const token = tokenOf(initial);
    const seed = "private original idea";
    const response = await admin(
      request("/personas/legacy", { draft: token, seed, intent: "character" }),
    );
    expect(response.status).toBe(503);
    const page = await response.text();
    expect(page).toContain(seed);
    expect(preview(page).prompt).toBe(legacy.prompt);
    expect(await store.get("legacy")).toEqual({ ...legacy, gender: "female" });
    expect(fetcher).toHaveBeenCalledTimes(replies.length);
    const failure = failureOf(logs, response);
    expect(failure).toMatchObject({
      stage,
      code,
      level: "error",
    });
    expect(failure.durationMs).toBeTypeOf("number");
    expect(logs.at(-1)).toMatchObject({ event: "request.completed", status: 503 });
    const diagnostic = JSON.stringify(logs);
    for (const secret of [
      seed,
      token,
      "private-key",
      "private finding",
      "private remaining finding",
      sheet.appearance,
      sheet.base.sensitivity.reason,
    ])
      expect(diagnostic).not.toContain(secret);
  },
);

test("a review provider failure is diagnosed once with its underlying code and private content redacted", async () => {
  const key = "private-provider-key";
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(characterResponse())
    .mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message: `${key} ${sheet.hidden[0]!.reason} ${sheet.base.sensitivity.reason} provider quota exceeded`,
          },
        },
        { status: 429 },
      ),
    );
  const { admin, logs } = await fixture({
    ...generator,
    ...createProfileGenerator({ key, fetcher }),
  });
  const response = await admin(
    request("/personas", {
      draft: await newToken(admin),
      seed: "private seed",
      intent: "character",
    }),
  );
  expect(response.status).toBe(503);
  const failure = failureOf(logs, response);
  expect(failure).toMatchObject({
    stage: "generation.api",
    code: "429",
    status: 429,
    providerStatus: "RESOURCE_EXHAUSTED",
  });
  expect(failure.error?.message).toContain("provider quota exceeded");
  const output = JSON.stringify(logs);
  for (const secret of [
    key,
    sheet.hidden[0]!.reason,
    sheet.base.sensitivity.reason,
    "private seed",
  ])
    expect(output).not.toContain(secret);
});
