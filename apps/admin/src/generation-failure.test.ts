import { expect, test, vi } from "vitest";
import { CharacterFormatError, renderCharacterSheet } from "@ren-ai/personas";
import { withPublicProfile } from "@ren-ai/personas/profile";
import {
  fixture,
  legacy,
  request,
  tokenOf,
  generator,
  character,
  newToken,
} from "../test/fixtures.ts";
import { sheet } from "../test/character.ts";
import { modelReply, preview } from "../test/sub-portraits.ts";
import { createProfileGenerator } from "./generation.ts";
import { GenerationError, validationFailure } from "./logging.ts";
import { characterValidationFields, generationFailureMessage } from "./generation-failure.ts";

test("image failure responses explain Google's location rejection and preserve correlation", async () => {
  const error = new GenerationError("User location is not supported for the API use.", {
    status: 400,
    providerStatus: "FAILED_PRECONDITION",
  });
  const { admin, logs } = await fixture({
    ...generator,
    portrait: async () => {
      throw error;
    },
  });
  const response = await admin(
    request("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
  );
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("서버의 요청 지역을 지원하지 않아");
  expect(logs.some((entry) => entry.providerStatus === "FAILED_PRECONDITION")).toBe(true);
  expect(
    generationFailureMessage(
      new GenerationError("Other precondition", { providerStatus: "FAILED_PRECONDITION" }),
    ),
  ).toBeUndefined();
});

test("conversion reports the rejected section and rule without leaking generated content", async () => {
  const secret = "private generated invalid sample";
  const output = withPublicProfile(
    renderCharacterSheet({ ...sheet, samples: [secret] }),
    "안녕하세요.",
  );
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(modelReply(output));
  const { admin, store, logs } = await fixture(
    createProfileGenerator({ key: "private-key", fetcher }),
  );
  await store.create({ ...legacy, name: sheet.name, gender: "female" });
  const before = await store.get(legacy.id);
  const token = tokenOf(await (await admin(request(`/personas/${legacy.id}`))).text());
  const response = await admin(
    request(`/personas/${legacy.id}`, {
      draft: token,
      name: sheet.name,
      description: legacy.prompt,
      gender: "female",
      intent: "convert",
    }),
  );
  expect(response.status).toBe(503);
  const page = await response.text();
  expect(page).toContain("‘문자 예시’ 영역의 형식이 올바르지 않아");
  expect(page).not.toContain("생성 API 설정이나 저장소 상태를 확인");
  expect(page).toContain(response.headers.get("X-Request-ID"));
  expect(preview(page).prompt).toBe(before.prompt);
  expect(await store.get(legacy.id)).toEqual(before);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const failures = logs.filter((entry) => entry.event === "operation.failed");
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({
    requestId: response.headers.get("X-Request-ID"),
    stage: "character.draft",
    code: "invalid_character",
    causeCode: "invalid_description",
    validationSection: "문자 예시",
    validationRule: "sample_count",
  });
  for (const value of [secret, output, token, "private-key", legacy.prompt])
    expect(JSON.stringify(logs)).not.toContain(value);
});

test("validation diagnostics allowlist locations and rules and retain the original cause", () => {
  const cause = new CharacterFormatError("private heading", "private detail", "private excerpt");
  const error = validationFailure("Invalid persona Markdown", { code: "invalid_character" }, cause);
  expect(error.cause).toBe(cause);
  expect(error.fields).toMatchObject({
    validationSection: "문서 구조",
    validationRule: "structure",
  });
  expect(JSON.stringify(error.fields)).not.toContain("private");
  expect(characterValidationFields(new Error("private"))).toEqual({});
});

test.each([
  ["invalid_character", "AI가 생성한 캐릭터 문서의 형식"],
  ["invalid_character_review", "AI 캐릭터 검수에 실패"],
  ["character_review_failed", "AI 캐릭터 검수에 실패"],
  ["character_name_mismatch", "이름 또는 성별이 원본과 달라"],
  ["character_gender_mismatch", "이름 또는 성별이 원본과 달라"],
  ["missing_key", "생성 API 키가 설정되지 않았습니다"],
])("%s uses a specific safe explanation", (code, message) => {
  expect(
    generationFailureMessage(
      new GenerationError("private error", { code, validationSection: "private" }),
    ),
  ).toContain(message);
});

test("other generation failures retain the existing fallback", () => {
  expect(generationFailureMessage(new GenerationError("private", {}))).toBeUndefined();
});
