import { CharacterFormatError, privateSectionTitles } from "@ren-ai/personas";
import type { GenerationError } from "./logging.ts";

const rules = new Map([
  ["필수 섹션의 제목과 내용을 확인해 주세요.", "structure"],
  ["같은 섹션이 두 번 있습니다. 하나로 합쳐 주세요.", "duplicate_section"],
  ["필수 섹션의 내용이 비어 있습니다.", "empty_section"],
  [
    "이름: … / 성별: 여성 또는 남성 / 생년월일: YYYY-MM-DD와 외형 설명이 필요합니다.",
    "identity_format",
  ],
  ["생년월일은 YYYY-MM-DD 형식의 실제 날짜이며 미래일 수 없습니다.", "birth_date"],
  ["주 사용 언어와 모국어에 유효한 언어 코드를 작성해 주세요.", "language_background"],
  ["각 Stat을 “- 자율성: 85 — 근거”처럼 정수 0–100과 이유로 작성해 주세요.", "stat_format"],
  ["정의된 기본 성향 6개만 작성해 주세요.", "stat_name"],
  ["Stat은 정수 0–100이며 근거가 필요합니다.", "stat_value"],
  ["기본 성향 6개가 각각 한 번씩 있어야 합니다.", "stat_count"],
  ["특성 제목, 강도, 나타나는 상황과 이유 형식을 확인해 주세요.", "trait_format"],
  ["문자 예시를 “- 짧은 문자” 목록으로 작성해 주세요.", "sample_format"],
  ["문자 예시는 2–3개의 짧은 한 줄이어야 합니다.", "sample_count"],
  [
    "특성 이름은 중복할 수 없으며 강도는 정수 0–100입니다. 최대 6개만 작성해 주세요.",
    "trait_values",
  ],
]);

export function characterValidationFields(cause: Error) {
  if (!(cause instanceof CharacterFormatError)) return {};
  return {
    validationSection: privateSectionTitles.includes(cause.section) ? cause.section : "문서 구조",
    validationRule: rules.get(cause.detail) ?? "structure",
  };
}

export function generationFailureMessage(error: GenerationError) {
  if (
    error.fields.providerStatus === "FAILED_PRECONDITION" &&
    error.message === "User location is not supported for the API use."
  )
    return "Google 생성 API가 서버의 요청 지역을 지원하지 않아 거부했습니다. 실행 지역을 확인해 주세요. 기존 사진은 유지됩니다.";
  const { code, validationSection } = error.fields;
  if (code === "invalid_character") {
    const section =
      validationSection && privateSectionTitles.includes(validationSection)
        ? ` ‘${validationSection}’ 영역의`
        : "";
    return `AI가 생성한 캐릭터 문서의${section} 형식이 올바르지 않아 결과를 적용하지 않았습니다. 기존 결과는 유지됩니다. API 키나 저장소 설정 문제가 아닙니다.`;
  }
  if (code === "invalid_character_review" || code === "character_review_failed")
    return "AI 캐릭터 검수에 실패해 결과를 적용하지 않았습니다. 기존 결과는 유지됩니다.";
  if (code === "character_name_mismatch" || code === "character_gender_mismatch")
    return "AI가 생성한 캐릭터의 이름 또는 성별이 원본과 달라 결과를 적용하지 않았습니다. 기존 결과는 유지됩니다.";
  if (code === "missing_key")
    return "생성 API 키가 설정되지 않았습니다. Admin의 GEMINI_API_KEY 설정을 확인해 주세요. 기존 결과는 유지됩니다.";
  return undefined;
}
