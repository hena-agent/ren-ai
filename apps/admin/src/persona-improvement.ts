import {
  PersonaError,
  CharacterFormatError,
  documentStatus,
  serializePersona,
  versionedPersona,
} from "@ren-ai/personas";
import type { PersonaRecord } from "@ren-ai/personas";
import { withPublicProfile } from "@ren-ai/personas/profile";
import { characterOf, authorPersona } from "./authoring.ts";
import type { Draft } from "./draft.ts";
import type { ProfileGenerator } from "./generation.ts";
import { operation, GenerationError, protect, validationFailure } from "./logging.ts";

export function captureImprovement(form: FormData, draft: Draft): Draft {
  const scope = form.get("improvementScope") ?? "persona";
  const instructions = form.get("improvementInstructions") ?? "";
  if (
    (scope !== "persona" && scope !== "profile") ||
    typeof instructions !== "string" ||
    instructions.length > 4000
  )
    throw new PersonaError("invalid", "개선 범위와 4,000자 이하의 개선 요청을 확인해 주세요.");
  protect(instructions);
  return { ...draft, improvementInput: { scope, instructions: instructions.trim() } };
}

export async function improvePersona(
  persona: PersonaRecord,
  draft: Draft,
  generator: ProfileGenerator,
): Promise<Draft> {
  const input = draft.improvementInput!;
  const result = await operation("persona.improve", {}, async () => {
    const improved =
      input.scope === "profile"
        ? {
            description: withPublicProfile(
              persona.description!,
              await generator.profile(characterOf(persona), input.instructions),
            ),
            additions: ["공개 프로필을 개선했습니다. 비공개 인물 설정은 유지했습니다."],
          }
        : await generator.convert(characterOf(persona), input.instructions);
    protect(improved.description, ...improved.additions);
    if ("name" in improved && improved.name !== persona.name)
      throw new GenerationError("Improvement changed persona identity", {
        code: "improvement_identity_mismatch",
      });
    const status = documentStatus(improved.description, persona.name, persona.gender);
    if (status.state !== "valid")
      throw validationFailure(
        "Invalid improved Persona",
        { code: "invalid_character" },
        new CharacterFormatError(
          status.issues[0]?.section ?? "",
          status.issues[0]?.message ?? "Persona 문서가 비어 있습니다.",
        ),
      );
    return improved;
  });
  protect(result.description, ...result.additions);
  const form = new FormData();
  form.set("name", persona.name);
  form.set("description", result.description);
  if (persona.published) form.set("published", "on");
  const next = versionedPersona(authorPersona(form, persona));
  return {
    ...draft,
    preview: serializePersona(next),
    tab: "persona",
    imageEditing: true,
    conversion: {
      source: persona.description!,
      additions: result.additions,
    },
  };
}
