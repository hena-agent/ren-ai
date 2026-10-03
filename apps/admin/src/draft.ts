import { createHmac, timingSafeEqual } from "node:crypto";
import { Schema } from "effect";
import { parsePersona, PersonaError, serializePersona } from "@ren-ai/personas";
import type { PersonaRecord } from "@ren-ai/personas";
import copy from "./copy.json";
const Draft = Schema.Struct({
  id: Schema.String,
  // The original saved snapshot for stale-edit checks; empty for a new character.
  base: Schema.String,
  preview: Schema.String,
  seed: Schema.optionalKey(Schema.String),
});
export type Draft = typeof Draft.Type;

export function draftFor(persona: PersonaRecord, editing: boolean): Draft {
  const source = editing ? serializePersona(persona) : "";
  return { id: persona.id, base: source, preview: source };
}

export function draftTokens(password: string) {
  const digest = (value: string) => createHmac("sha256", password).update(value).digest();
  return {
    encode: (draft: Draft) => {
      const content = Buffer.from(JSON.stringify(draft)).toString("base64url");
      return `${content}.${digest(content).toString("base64url")}`;
    },
    decode: (value: FormDataEntryValue | null): Draft => {
      if (typeof value !== "string") throw new PersonaError("invalid", copy.formError);
      const parts = value.split(".");
      const [content, signature] = parts;
      if (parts.length !== 2 || !content || !signature)
        throw new PersonaError("invalid", copy.formError);
      const actual = Buffer.from(signature, "base64url");
      const expected = digest(content);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw new PersonaError("invalid", copy.formError);
      return Schema.decodeUnknownSync(Draft)(
        JSON.parse(Buffer.from(content, "base64url").toString()),
      );
    },
  };
}

export const previewOf = (draft: Draft, empty: Omit<PersonaRecord, "id">) =>
  draft.preview ? parsePersona(draft.id, draft.preview) : { ...empty, id: draft.id };
