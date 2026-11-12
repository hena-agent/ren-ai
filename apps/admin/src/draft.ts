import { Schema } from "effect";
import {
  IdentitySheets,
  InitialDocuments,
  parsePersona,
  PersonaError,
  serializePersona,
} from "@ren-ai/personas";
import type { PersonaRecord } from "@ren-ai/personas";
import copy from "./copy.json";
import { captureImprovement } from "./persona-improvement.ts";
import { RigArtwork } from "./rig-artwork-models.ts";
import { privateTokens } from "./private-token.ts";
const Draft = Schema.Struct({
  id: Schema.String,
  // The original saved snapshot for stale-edit checks; empty for a new character.
  base: Schema.String,
  legacySource: Schema.optionalKey(Schema.String),
  preview: Schema.String,
  rigArtwork: Schema.optionalKey(RigArtwork),
  sheets: Schema.optionalKey(IdentitySheets),
  initial: Schema.optionalKey(
    Schema.Struct({
      base: Schema.optionalKey(InitialDocuments),
      preview: Schema.optionalKey(InitialDocuments),
    }),
  ),
  tab: Schema.optionalKey(Schema.Literals(["persona", "state", "memory"])),
  conversion: Schema.optionalKey(
    Schema.Struct({
      source: Schema.String,
      additions: Schema.Array(Schema.String).check(Schema.isMaxLength(20)),
    }),
  ),
  improvementInput: Schema.optionalKey(
    Schema.Struct({
      scope: Schema.Literals(["persona", "profile"]),
      instructions: Schema.String,
    }),
  ),
  seed: Schema.optionalKey(Schema.String),
  characterPending: Schema.optionalKey(Schema.Boolean),
  portraitInstructions: Schema.optionalKey(Schema.String),
  imageInstructions: Schema.optionalKey(Schema.String),
  portraitOperation: Schema.optionalKey(Schema.String),
  imageDirection: Schema.optionalKey(Schema.String),
  imageEditing: Schema.optionalKey(Schema.Boolean),
  imagePrompts: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(12))),
  imageCount: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 6 })),
  ),
});
export type Draft = typeof Draft.Type;

export function assertDraftIdentity(draft: Draft, id: string | undefined) {
  if ((id && (id !== draft.id || !draft.base)) || (!id && draft.base))
    throw new PersonaError("invalid", copy.identityError);
}
export const documentsOf = (draft: Draft) =>
  draft.initial?.preview ?? draft.initial?.base ?? { state: "", memory: "" };

export const draftFields = (draft: Draft) => ({
  rigArtwork: draft.rigArtwork,
  sheets: draft.sheets,
  documents: documentsOf(draft),
  tab: draft.tab,
  showIdea: Boolean(draft.characterPending),
  improvementInput: draft.improvementInput,
});

export function captureDocuments(form: FormData, draft: Draft): Draft {
  const previous = documentsOf(draft);
  const read = (key: "state" | "memory") => {
    const value = form.get(`${key}Source`);
    if (value === null) return previous[key];
    if (typeof value !== "string" || value.length > 16000)
      throw new PersonaError("invalid", "문서는 16,000자 이하의 원문이어야 합니다.");
    return value.replace(/\r\n?/g, "\n");
  };
  const tab = form.get("tab") ?? draft.tab ?? "persona";
  if (tab !== "persona" && tab !== "state" && tab !== "memory")
    throw new PersonaError("invalid", copy.formError);
  const next: Draft = {
    ...draft,
    tab,
    initial: { ...draft.initial, preview: { state: read("state"), memory: read("memory") } },
  };
  return form.get("intent") === "improve" ? captureImprovement(form, next) : next;
}

function draftFor(persona: PersonaRecord, editing: boolean): Draft {
  const source = editing ? serializePersona(persona) : "";
  return { id: persona.id, base: source, preview: source };
}

export function restoreDraft(
  persona: PersonaRecord,
  editing: boolean,
  cached: Draft | undefined,
): Draft {
  const saved = draftFor(persona, editing);
  const restored = cached?.base === saved.base && cached.imageEditing ? cached : saved;
  return cached?.rigArtwork ? { ...restored, rigArtwork: cached.rigArtwork } : restored;
}

export function completedImageDraft(draft: Draft): Draft {
  const next = { ...draft, imageEditing: true };
  delete next.portraitInstructions;
  delete next.imageInstructions;
  delete next.portraitOperation;
  delete next.imageDirection;
  delete next.imageCount;
  delete next.imagePrompts;
  return next;
}

export function draftTokens(password: string) {
  const tokens = privateTokens(password);
  return {
    encode: (draft: Draft) => tokens.encode(JSON.stringify(draft)),
    decode: (value: FormDataEntryValue | null): Draft => {
      return Schema.decodeUnknownSync(Draft)(JSON.parse(tokens.decode(value)));
    },
  };
}

export const previewOf = (draft: Draft, empty: Omit<PersonaRecord, "id">) =>
  draft.preview ? parsePersona(draft.id, draft.preview) : { ...empty, id: draft.id };
