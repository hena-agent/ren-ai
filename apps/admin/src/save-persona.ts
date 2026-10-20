import { decodePersona, PersonaError, serializePersona, versionedPersona } from "@ren-ai/personas";
import type { PersonaRecord, PersonaStore } from "@ren-ai/personas";
import { documentsOf } from "./draft.ts";
import type { Draft } from "./draft.ts";
import { operation } from "./logging.ts";

export async function savePersonaDraft(
  persona: PersonaRecord,
  draft: Draft,
  store: PersonaStore,
): Promise<Draft> {
  const valid = decodePersona(versionedPersona(persona));
  if (valid.published && !valid.imageUrl)
    throw new PersonaError("invalid", "공개하려면 소개와 프로필 이미지가 필요합니다.");
  const documents = documentsOf(draft);
  const saved = await operation("persona.save", {}, () =>
    store.save(valid, documents, {
      persona: draft.base,
      ...(draft.initial?.base && { initial: draft.initial.base }),
      ...(draft.legacySource && { legacySource: draft.legacySource }),
    }),
  );
  const source = serializePersona(saved);
  return {
    id: draft.id,
    base: source,
    preview: source,
    initial: { base: documents, preview: documents },
    ...(draft.sheets && { sheets: draft.sheets }),
  };
}
