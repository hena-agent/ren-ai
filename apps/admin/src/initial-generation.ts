import { Schema } from "effect";
import type { JsonSchema } from "effect";
import {
  InitialScores,
  InitialDocuments,
  initialTraits,
  serializeInitialState,
  validateInitialDocuments,
  validateInitialMemory,
  parseCharacterDescription,
  LanguageProficiency,
  CharacterSheet,
  LanguageBackground,
  stateStatus,
} from "@ren-ai/personas";
import { splitPersonaMarkdown } from "@ren-ai/personas/profile";
import { protect, validationFailure } from "./logging.ts";
import type { LogFields } from "./logging.ts";
import policy from "./initial-policy.json";

const GeneratedState = Schema.Struct({
  ...InitialScores.fields,
  languageProficiency: Schema.optionalKey(LanguageProficiency),
});
export const GeneratedPersona = Schema.Struct({
  persona: Schema.Struct({ ...CharacterSheet.fields, languageBackground: LanguageBackground }),
  publicProfile: Schema.String,
  state: Schema.Struct({ ...GeneratedState.fields, languageProficiency: LanguageProficiency }),
  memory: InitialDocuments.fields.memory,
});

export function generatedInitial(
  source: string,
  state: typeof GeneratedState.Type,
  memory: string,
) {
  validateInitialMemory(memory);
  return validateInitialDocuments({
    state: serializeInitialState({ ...state, traits: initialTraits(source) }),
    memory: memory.trim() + "\n",
  });
}

export async function generateInitialDocument(
  request: (
    prompt: string,
    input: string,
    schema?: JsonSchema.JsonSchema,
  ) => Promise<{ text: string; fields: LogFields }>,
  source: string,
  target: "state" | "memory",
) {
  const character = parseCharacterDescription(source);
  const stateSchema = character.languageBackground ? GeneratedPersona.fields.state : GeneratedState;
  const schema = target === "state" ? Schema.toJsonSchemaDocument(stateSchema).schema : undefined;
  const response = await request(
    `${policy[target]}${target === "state" ? `\n\n${policy.affection}\n\n${languageDirection}` : ""}`,
    splitPersonaMarkdown(source).privateMarkdown,
    schema,
  );
  protect(response.text);
  try {
    if (target === "state") {
      const scores = Schema.decodeUnknownSync(stateSchema)(JSON.parse(response.text), {
        onExcessProperty: "error",
      });
      const state = serializeInitialState({ ...scores, traits: initialTraits(source) });
      if (stateStatus(state, source).state !== "valid")
        throw new Error("Generated State language proficiency does not match Persona");
      return state;
    }
    const memory =
      Schema.decodeUnknownSync(InitialDocuments.fields.memory)(response.text).trim() + "\n";
    return validateInitialMemory(memory);
  } catch (cause) {
    throw validationFailure(
      "Invalid initial document",
      { ...response.fields, code: "invalid_initial_document" },
      cause,
    );
  }
}

export const languageDirection =
  "입력·운영 화면의 언어와 Persona의 언어는 별개다. 이름은 배경에 자연스러운 원어 표기, 공개 프로필과 문자 예시는 Persona의 주 사용 언어, 말투는 그 언어·성격·생활에 어울리게 작성해. 별도 설정 없는 미국인은 영어가 기준이며 한국어 입력 때문에 한국인·한국어 이름·한국어 사용자로 바꾸지 마. 비공개 운영 설명은 입력 언어로 작성해도 된다. 한국어 존댓말이나 외국어 실력을 기본으로 부여하지 마. 오타쿠 취향만으로 일본어를 잘한다고 가정하지 마. 언어 코드는 en, ko, ja처럼 언어 단위로 통일하고 en-US 같은 지역 태그는 쓰지 마. 지역 억양·말투는 Persona 설명에 담아. 인물 생성에서는 persona.languageBackground.primary에 주 사용 언어, native에 모국어 배열을 반드시 작성해. state.languageProficiency는 언어 코드별 beginner·conversational·proficient·fluent 중 하나로 작성하고 주 사용 언어의 실력과 모든 모국어의 fluent를 포함해. 근거 없는 외국어 실력은 추가하지 말고 한국어도 학습 배경과 명시된 실력에 따라 선택해. 초기 State만 생성할 때는 원본 Persona의 언어 배경을 유지해. 검수에서는 이름·공개 글·문자 예시의 언어와 배경을 확인하고, State가 함께 주어졌다면 Persona의 언어 코드와 실력의 일치도 확인해. Persona만 개선하는 요청에서는 State를 새로 만들거나 반환하지 마. 모순을 고칠 때 무조건 fluent로 올리지 말고 모국어·학습 배경 설정도 확인해. languageProficiency는 운영자 검토 후 저장할 초기 실력이다.";
