import { Schema } from "effect";
import type { JsonSchema } from "effect";
import { parseCharacterDescription } from "@ren-ai/personas";
import { requirePublicProfile } from "@ren-ai/personas/profile";
import policy from "./character-policy.json";
import profilePolicy from "./policy.json";
import { GenerationError, operation, protect, validationFailure } from "./logging.ts";
import type { LogFields } from "./logging.ts";
import { GeneratedPersona, generatedInitial, languageDirection } from "./initial-generation.ts";
import initialPolicy from "./initial-policy.json";
import { profileWriting } from "./profile-writing.ts";

const Review = Schema.Struct({
  issues: Schema.Array(Schema.String.check(Schema.isPattern(/\S/))).check(Schema.isMaxLength(12)),
  additions: Schema.Array(Schema.String.check(Schema.isPattern(/\S/))).check(
    Schema.isMaxLength(20),
  ),
});
type Request = (
  prompt: string,
  input: string,
  schema?: JsonSchema.JsonSchema,
) => Promise<{ text: string; fields: LogFields }>;

async function author(
  request: Request,
  seed: string,
  gender?: "female" | "male",
  name?: string,
  instructions = "",
) {
  protect(seed, instructions);
  const original = `${seed}${gender ? `\nSELECTED GENDER: ${gender}` : ""}${name ? `\nSAVED NAME: ${name}\nIMPROVEMENT REQUEST:\n${instructions}` : ""}`;
  let diagnostic: LogFields = {};
  const create = (repair?: { document: string; issues: readonly string[] }) =>
    operation(repair ? "character.repair" : "character.draft", {}, async () => {
      const response = await request(
        `${repair ? policy.repair : name ? policy.convert : policy.generate}\n\n${policy.reference}\n\n${profileWriting}\n\n${profilePolicy.genderDirection}${name ? "" : `\n\n${initialPolicy.generate}\n\n${initialPolicy.affection}\n\n${languageDirection}\n\npersona는 완성된 Persona Markdown, state는 컨디션 5개와 초기 호감도 affection 및 languageProficiency, memory는 초기 생활 기억인 JSON 객체를 한 요청에서 작성해. Persona 본문에는 상태·기억을 넣지 마. 보정도 이 JSON 객체 전체를 반환해.`}`,
        repair
          ? `${original}\n\nDOCUMENT:\n${repair.document}\n\nISSUES:\n${JSON.stringify(repair.issues)}`
          : original,
        name ? undefined : Schema.toJsonSchemaDocument(GeneratedPersona).schema,
      );
      diagnostic = response.fields;
      protect(response.text);
      try {
        const packet = name
          ? undefined
          : Schema.decodeUnknownSync(GeneratedPersona)(JSON.parse(response.text), {
              onExcessProperty: "error",
            });
        const description = packet?.persona ?? response.text;
        const parts = requirePublicProfile(description);
        const sheet = parseCharacterDescription(parts.privateMarkdown);
        const { base, hidden, samples, languageBackground: background, ...text } = sheet;
        protect(
          ...Object.values(text),
          ...(background ? [background.primary, ...background.native] : []),
          ...samples,
          ...Object.values(base).map((stat) => stat.reason),
          ...hidden.flatMap((trait) => [trait.name, trait.context, trait.reason]),
        );
        if (gender && sheet.gender !== gender)
          throw new GenerationError("Character gender does not match selection", {
            ...diagnostic,
            code: "character_gender_mismatch",
          });
        if (name && sheet.name !== name)
          throw new GenerationError("Character name does not match saved identity", {
            ...diagnostic,
            code: "character_name_mismatch",
          });
        return {
          name: sheet.name,
          description: description.trim(),
          ...(packet && {
            initial: generatedInitial(description, packet.state, packet.memory),
            reviewDocument: JSON.stringify(packet),
          }),
        };
      } catch (cause) {
        if (cause instanceof GenerationError) throw cause;
        throw validationFailure(
          "Invalid persona Markdown",
          { ...diagnostic, code: "invalid_character" },
          cause,
        );
      }
    });
  const review = (document: string) =>
    operation("character.review", {}, async () => {
      const response = await request(
        `${policy.review}\n\n${policy.reference}\n\n${profileWriting}\n\n${profilePolicy.genderDirection}${name ? "" : `\n${initialPolicy.affection}\n세 문서의 인물 일관성, 초기 상태와 생활 기억의 적합성도 함께 검수해. 생활 보강은 허용하지만 사용자 경험·약속은 없어야 한다.`}`,
        `${original}\n\nDOCUMENT:\n${document}`,
        Schema.toJsonSchemaDocument(Review).schema,
      );
      diagnostic = response.fields;
      protect(response.text);
      try {
        const result = Schema.decodeUnknownSync(Review)(JSON.parse(response.text), {
          onExcessProperty: "error",
        });
        protect(...result.issues, ...result.additions);
        return result;
      } catch (cause) {
        throw validationFailure(
          "Invalid character review",
          { ...diagnostic, code: "invalid_character_review" },
          cause,
        );
      }
    });
  let result = await create();
  let inspected = await review(result.reviewDocument ?? result.description);
  if (inspected.issues.length) {
    result = await create({
      document: result.reviewDocument ?? result.description,
      issues: inspected.issues,
    });
    inspected = await review(result.reviewDocument ?? result.description);
    if (inspected.issues.length)
      throw new GenerationError("Character review failed after repair", {
        ...diagnostic,
        stage: "character.review",
        code: "character_review_failed",
      });
  }
  return { ...result, additions: inspected.additions };
}

export async function generateCharacter(
  request: Request,
  seed: string,
  gender?: "female" | "male",
) {
  const result = await author(request, seed, gender);
  return { name: result.name, description: result.description, initial: result.initial! };
}
export const convertCharacter = (
  request: Request,
  source: { name: string; description: string; gender?: "female" | "male" },
  instructions?: string,
) => author(request, source.description, source.gender, source.name, instructions);
