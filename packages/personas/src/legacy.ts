import { Schema } from "effect";
import { parseDocument } from "yaml";
import { decodePersona, PersonaError } from "./model.ts";
import { withPublicProfile } from "./profile.ts";

const TextFields = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number]));
const Legacy = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  bio: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  gender: Schema.optionalKey(Schema.Literals(["female", "male"])),
  published: Schema.optionalKey(Schema.Boolean),
  "time-zone": Schema.String,
  language: Schema.String,
  "opening-line": Schema.String,
  memory: Schema.String,
  "image-url": Schema.optionalKey(Schema.String),
  portraits: Schema.optionalKey(
    Schema.Struct({
      anime: Schema.optionalKey(Schema.String),
      photo: Schema.optionalKey(Schema.String),
    }),
  ),
  "secondary-portraits": Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ style: Schema.Literals(["anime", "photo"]), imageUrl: Schema.String }),
    ),
  ),
  "profile-details": Schema.optionalKey(
    Schema.Struct({
      basics: Schema.optionalKey(TextFields),
      lifestyle: Schema.optionalKey(TextFields),
      relationship: Schema.optionalKey(TextFields),
      interests: Schema.optionalKey(Schema.Array(Schema.String)),
      answers: Schema.optionalKey(
        Schema.Array(Schema.Struct({ question: Schema.String, answer: Schema.String })),
      ),
    }),
  ),
});

function legacyPublicMarkdown(fields: typeof Legacy.Type) {
  const profile = fields["profile-details"];
  const groups = [
    ["기본 정보", profile?.basics],
    ["라이프스타일", profile?.lifestyle],
    ["관계 스타일", profile?.relationship],
  ] as const;
  return [
    fields.bio ?? "",
    ...groups.flatMap(([title, values]) =>
      values && Object.keys(values).length
        ? [
            `### ${title}\n${Object.entries(values)
              .map(([key, value]) => `- ${key}: ${value}`)
              .join("\n")}`,
          ]
        : [],
    ),
    ...(profile?.interests?.length
      ? [`### 관심사\n${profile.interests.map((item) => `- ${item}`).join("\n")}`]
      : []),
    ...(profile?.answers?.map((item) => `### ${item.question}\n${item.answer}`) ?? []),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Explicit designer conversion only. Runtime readers never call this decoder.
export function legacyPersonaDraft(id: string, source: string) {
  try {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)/.exec(source);
    if (!match) throw new Error();
    const fields = Schema.decodeUnknownSync(Legacy)(parseDocument(match[1]!).toJS());
    if (
      fields.bio === undefined &&
      fields.description === undefined &&
      fields["profile-details"] === undefined
    )
      throw new Error();
    const publicMarkdown = legacyPublicMarkdown(fields);
    const description = withPublicProfile(fields.description ?? match[2]!, publicMarkdown);
    return decodePersona({
      id,
      name: fields.name ?? id,
      description,
      prompt: description,
      bio: "",
      imageUrl: fields["image-url"] ?? "",
      published: fields.published ?? false,
      timeZone: fields["time-zone"],
      language: fields.language,
      openingLine: fields["opening-line"],
      memory: fields.memory,
      ...(fields.gender && { gender: fields.gender }),
      ...(fields.portraits && { portraits: fields.portraits }),
      ...(fields["secondary-portraits"] && { secondaryPortraits: fields["secondary-portraits"] }),
    });
  } catch {
    throw new PersonaError("invalid", "기존 파일의 설정과 공개 소개를 확인해 주세요.");
  }
}
