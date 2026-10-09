import { Schema } from "effect";
import type { JsonSchema } from "effect";
import { parseCharacterDescription } from "./character-format.ts";
import { requirePublicProfile } from "@ren-ai/personas/profile";
import policy from "./character-policy.json";
import profilePolicy from "./policy.json";
import { GenerationError, operation, protect, validationFailure } from "./logging.ts";
import type { LogFields } from "./logging.ts";

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

async function author(request: Request, seed: string, gender?: "female" | "male", name?: string) {
  const original = `${seed}${gender ? `\nSELECTED GENDER: ${gender}` : ""}${name ? `\nSAVED NAME: ${name}` : ""}`;
  let diagnostic: LogFields = {};
  const create = (repair?: { document: string; issues: readonly string[] }) =>
    operation(repair ? "character.repair" : "character.draft", {}, async () => {
      const response = await request(
        `${repair ? policy.repair : name ? policy.convert : policy.generate}\n\n${policy.reference}\n\n${profilePolicy.genderDirection}`,
        repair
          ? `${original}\n\nDOCUMENT:\n${repair.document}\n\nISSUES:\n${JSON.stringify(repair.issues)}`
          : original,
      );
      diagnostic = response.fields;
      protect(response.text);
      try {
        const parts = requirePublicProfile(response.text);
        const sheet = parseCharacterDescription(parts.privateMarkdown);
        const { base, hidden, samples, ...text } = sheet;
        protect(
          ...Object.values(text),
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
        return { name: sheet.name, description: response.text.trim() };
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
        `${policy.review}\n\n${policy.reference}\n\n${profilePolicy.genderDirection}`,
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
  let inspected = await review(result.description);
  if (inspected.issues.length) {
    result = await create({ document: result.description, issues: inspected.issues });
    inspected = await review(result.description);
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
  const { name, description } = await author(request, seed, gender);
  return { name, description };
}
export const convertCharacter = (
  request: Request,
  source: { name: string; description: string; gender?: "female" | "male" },
) => author(request, source.description, source.gender, source.name);
