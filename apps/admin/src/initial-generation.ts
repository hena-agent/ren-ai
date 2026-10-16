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
  persona: Schema.String,
  state: GeneratedState,
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
  parseCharacterDescription(source);
  const schema =
    target === "state" ? Schema.toJsonSchemaDocument(GeneratedState).schema : undefined;
  const response = await request(
    `${policy[target]}${target === "state" ? `\n\n${policy.affection}\n\n${languageDirection}` : ""}`,
    splitPersonaMarkdown(source).privateMarkdown,
    schema,
  );
  protect(response.text);
  try {
    if (target === "state") {
      const scores = Schema.decodeUnknownSync(GeneratedState)(JSON.parse(response.text), {
        onExcessProperty: "error",
      });
      return serializeInitialState({ ...scores, traits: initialTraits(source) });
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
  "state.languageProficiency에 언어 코드(ko, en, ja 등)를 key로, beginner·conversational·proficient·fluent 중 하나를 값으로 제안해. Persona의 출신·교육·학습 경험과 명시된 실력을 근거로 하고 근거 없는 외국어 실력은 추가하지 마. 모국어는 fluent이며 모국어 여부 자체는 Persona의 정체성·외형에 주 사용 언어: ko / 모국어: ko처럼 별도 줄로 작성해. languageProficiency는 초기 실력으로 운영자 검토 후 저장한다. 실력에 대한 근거는 Persona의 언어 배경 설명에 담아.";
