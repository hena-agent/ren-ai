import { Schema } from "effect";
import type { PersonaRecord } from "./model.ts";
import { BirthDate, birthDateOf } from "./birth-date.ts";
import { parseInitialState } from "./initial.ts";
import { PublicLanguages, languageSummary } from "./languages.ts";
import { projectPublicProfile } from "./profile-projection.ts";
import { PublicProfile } from "./public-profile.ts";

/**
 * Everything readers derive from a Persona's Markdown and initial State, computed once when she
 * is saved. Only a published Persona carries the public part, validated as Discovery reads it.
 */
const PersonaProjection = Schema.fromJsonString(
  Schema.Struct({
    bio: Schema.String,
    publicProfile: Schema.String,
    public: Schema.optionalKey(
      Schema.Struct({
        profile: PublicProfile,
        birthDate: Schema.optionalKey(BirthDate),
        languages: Schema.optionalKey(PublicLanguages),
      }),
    ),
  }),
);

const publicPart = (record: PersonaRecord, state: string) => {
  const markdown = record.description ?? record.prompt;
  const birthDate = birthDateOf(markdown);
  const languages = state.trim()
    ? languageSummary(markdown, parseInitialState(state).languageProficiency)
    : undefined;
  return {
    profile: projectPublicProfile(record.publicProfile ?? ""),
    ...(birthDate && { birthDate }),
    ...(languages && { languages }),
  };
};

/** `record` comes from `decodePersona`, which already split her public Markdown. */
export const projectPersona = (record: PersonaRecord, state: string) =>
  Schema.encodeSync(PersonaProjection)({
    bio: record.bio,
    publicProfile: record.publicProfile ?? "",
    ...(record.published && { public: publicPart(record, state) }),
  });

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: a stored projection column
export const readProjection = (stored: unknown) =>
  Schema.decodeUnknownSync(PersonaProjection)(stored);
