import { parseCharacterDescription } from "./character-format.ts";
import { PersonaError } from "./model.ts";
import type { PersonaRecord } from "./model.ts";
import { validateInitialDocuments, validateInitialMemory } from "./initial.ts";
import type { InitialDocuments } from "./initial.ts";
import { stateStatus } from "./state-diagnostics.ts";
import { documentStatus } from "./document-diagnostics.ts";

export function initialTraits(source: string) {
  return Object.fromEntries(
    parseCharacterDescription(source).hidden.map((trait) => [
      trait.name,
      {
        strength: trait.strength,
        active: true,
        persistence: "lasting" as const,
      },
    ]),
  );
}

function checkState(state: string, source: string) {
  if (stateStatus(state, source).state !== "valid")
    throw new PersonaError(
      "invalid",
      "STATE.md의 특성 이름·강도는 PERSONA의 숨겨진 특성과 일치해야 합니다.",
    );
}

export function checkInitialPersona(documents: InitialDocuments, source: string) {
  validateInitialDocuments(documents);
  checkState(documents.state, source);
  return documents;
}

export function publicationIssues(
  persona: Pick<PersonaRecord, "name" | "gender" | "prompt" | "description" | "imageUrl">,
  documents?: InitialDocuments,
) {
  const issues: { tab: "persona" | "state" | "memory"; message: string }[] = [];
  const source = persona.description ?? persona.prompt;
  const status = documentStatus(source, persona.name, persona.gender);
  if (status.state === "empty")
    issues.push({
      tab: "persona",
      message: "Persona 문서를 작성해 주세요.",
    });
  for (const issue of status.issues)
    issues.push({
      tab: "persona",
      message: `${issue.line}행 · ${issue.section}: ${issue.message}`,
    });
  if (!persona.imageUrl)
    issues.push({ tab: "persona", message: "공개하려면 프로필 사진이 필요합니다." });
  try {
    if (!documents?.state.trim()) throw new Error("missing");
    checkState(documents.state, source);
  } catch {
    issues.push({
      tab: "state",
      message: "State가 없거나 형식·수치·숨겨진 특성이 Persona와 맞지 않습니다.",
    });
  }
  try {
    validateInitialMemory(documents?.memory ?? "");
  } catch {
    issues.push({
      tab: "memory",
      message: "Memory에 ‘# 현재 생활’ 제목과 실제 생활 내용을 작성해 주세요.",
    });
  }
  return issues;
}
