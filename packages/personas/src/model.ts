import { Schema } from "effect";
import { parseDocument, stringify } from "yaml";
import { normalizePortraits } from "./portraits.ts";
import type { PersonaImage } from "./portraits.ts";
import { splitPersonaMarkdown } from "./profile.ts";
import { InitialDocuments } from "./initial-documents.ts";

export interface Persona {
  readonly name?: string;
  readonly bio?: string;
  readonly imageUrl?: string;
  readonly published?: boolean;
  readonly id: string;
  readonly timeZone: string;
  readonly language: string;
  readonly openingLine: string;
  readonly memory: string;
  readonly prompt: string;
  /** Initial conversation documents, supplied by the private runtime Catalog. */
  readonly initial?: InitialDocuments;
  /** Saved Persona document revision, never part of the prompt body. */
  readonly version?: number;
}

export interface PersonaRecord extends Persona {
  readonly name: string;
  readonly bio: string;
  readonly imageUrl: string;
  readonly published: boolean;
  readonly description?: string;
  readonly gender?: "female" | "male";
  readonly descriptionVersion?: number;
  readonly publicProfile?: string;
  readonly portraits?: { readonly anime?: string; readonly photo?: string };
  readonly secondaryPortraits?: readonly PersonaImage[];
  readonly portraitGallery?: readonly { readonly anime: string; readonly photo: string }[];
}

export class PersonaError extends Error {
  constructor(
    readonly kind: "invalid" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

const PortraitPair = Schema.Struct({
  anime: Schema.String.check(Schema.isNonEmpty()),
  photo: Schema.String.check(Schema.isNonEmpty()),
});
const MainPortraits = Schema.Struct({
  anime: Schema.optionalKey(PortraitPair.fields.anime),
  photo: Schema.optionalKey(PortraitPair.fields.photo),
}).check(Schema.makeFilter((value) => Boolean(value.anime || value.photo)));
const SecondaryPortraits = Schema.Array(
  Schema.Struct({
    style: Schema.Literals(["anime", "photo"]),
    imageUrl: Schema.String.check(Schema.isNonEmpty()),
  }),
).check(Schema.isMaxLength(10));
const Frontmatter = Schema.Struct({
  version: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ),
  "time-zone": Schema.String,
  language: Schema.String,
  "opening-line": Schema.String,
  memory: Schema.String,
  name: Schema.optionalKey(Schema.String),
  "image-url": Schema.optionalKey(Schema.String),
  published: Schema.optionalKey(Schema.Boolean),
  gender: Schema.optionalKey(Schema.Literals(["female", "male"])),
  "description-version": Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ),
  portraits: Schema.optionalKey(MainPortraits),
  "secondary-portraits": Schema.optionalKey(SecondaryPortraits),
  "portrait-gallery": Schema.optionalKey(
    Schema.Array(PortraitPair).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
  ),
});

const Input = Schema.Struct({
  version: Frontmatter.fields.version,
  id: Schema.String,
  name: Schema.String,
  bio: Schema.String,
  imageUrl: Schema.String,
  published: Schema.Boolean,
  timeZone: Schema.String,
  language: Schema.String,
  openingLine: Schema.String,
  memory: Schema.String,
  prompt: Schema.String,
  description: Schema.optionalKey(Schema.String.check(Schema.isPattern(/\S/))),
  gender: Frontmatter.fields.gender,
  descriptionVersion: Frontmatter.fields["description-version"],
  publicProfile: Schema.optionalKey(Schema.String),
  portraits: Frontmatter.fields.portraits,
  secondaryPortraits: Frontmatter.fields["secondary-portraits"],
  portraitGallery: Frontmatter.fields["portrait-gallery"],
  initial: Schema.optionalKey(InitialDocuments),
});

export function validateID(id: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
    throw new PersonaError(
      "invalid",
      "ID는 영문·숫자로 시작하는 1~64자의 영문·숫자·밑줄·하이픈이어야 합니다.",
    );
  }
}

function validateRuntime(persona: Persona) {
  if (
    ![persona.language, persona.openingLine, persona.memory, persona.prompt].every((v) => v.trim())
  ) {
    throw new Error(`Persona ${persona.id}: runtime fields must not be empty`);
  }
  try {
    Intl.DateTimeFormat("en", { timeZone: persona.timeZone }).resolvedOptions();
  } catch {
    throw new Error(`Persona ${persona.id}: invalid time-zone: ${persona.timeZone}`);
  }
}

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrows submitted persona fields before storage
export function decodePersona(input: unknown): PersonaRecord {
  try {
    const fields = Schema.decodeUnknownSync(Input)(input, { onExcessProperty: "error" });
    const markdown = fields.description ?? fields.prompt;
    const parts = splitPersonaMarkdown(markdown);
    const persona = normalizePortraits({
      ...fields,
      description: markdown,
      prompt: markdown,
      bio: parts.bio,
      publicProfile: parts.publicMarkdown,
    });
    validateID(persona.id);
    validateRuntime(persona);
    if (!persona.name.trim()) throw new Error("이름을 입력해 주세요.");
    const secondary = persona.secondaryPortraits;
    const images = [
      persona.imageUrl,
      ...Object.values(persona.portraits ?? {}),
      ...(secondary?.map((image) => image.imageUrl) ?? []),
    ].filter(Boolean);
    if (secondary) {
      const counts = { anime: 0, photo: 0 };
      for (const image of secondary) {
        counts[image.style] += 1;
        if (counts[image.style] > 5) throw new Error("스타일별 서브 이미지는 최대 5장입니다.");
      }
    }
    for (const imageUrl of images)
      if (
        !/^\/discovery\/images\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:png|jpg|webp)$/.test(
          imageUrl,
        ) &&
        new URL(imageUrl).protocol !== "https:"
      ) {
        throw new Error("프로필 이미지는 HTTPS URL이어야 합니다.");
      }
    if (persona.published && !persona.bio.trim()) {
      throw new Error("공개하려면 소개가 필요합니다.");
    }
    return persona;
  } catch (error) {
    throw new PersonaError("invalid", String(error));
  }
}

export function parsePersona(id: string, source: string): PersonaRecord {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)/.exec(source);
  if (!match) throw new Error(`Persona ${id}: expected YAML frontmatter and prompt`);
  const document = parseDocument(match[1]!);
  if (document.errors.length) throw new Error(`Persona ${id}: ${document.errors[0]!.message}`);
  let fields: typeof Frontmatter.Type;
  try {
    fields = Schema.decodeUnknownSync(Frontmatter)(document.toJS(), { onExcessProperty: "error" });
  } catch (error) {
    throw new Error(`Persona ${id}: invalid frontmatter: ${String(error)}`, { cause: error });
  }
  const persona = {
    id,
    timeZone: fields["time-zone"],
    language: fields.language,
    openingLine: fields["opening-line"],
    memory: fields.memory,
    prompt: match[2]!,
    name: fields.name ?? id,
    bio: "",
    imageUrl: fields["image-url"] ?? "",
    published: fields.published ?? false,
    description: match[2]!,
    ...(fields.version === undefined ? {} : { version: fields.version }),
    ...(fields.gender === undefined ? {} : { gender: fields.gender }),
    ...(fields["description-version"] === undefined
      ? {}
      : { descriptionVersion: fields["description-version"] }),
    ...(fields.portraits === undefined ? {} : { portraits: fields.portraits }),
    ...(fields["secondary-portraits"] === undefined
      ? {}
      : { secondaryPortraits: fields["secondary-portraits"] }),
    ...(fields["portrait-gallery"] === undefined
      ? {}
      : { portraitGallery: fields["portrait-gallery"] }),
  };
  return decodePersona(persona);
}

export function serializePersona(persona: PersonaRecord): string {
  persona = normalizePortraits(persona);
  return `---\n${stringify({
    "time-zone": persona.timeZone,
    language: persona.language,
    "opening-line": persona.openingLine,
    memory: persona.memory,
    name: persona.name,
    "image-url": persona.imageUrl,
    published: persona.published,
    gender: persona.gender,
    "description-version": persona.descriptionVersion,
    version: persona.version,
    portraits: persona.portraits,
    "secondary-portraits": persona.secondaryPortraits,
  })}---\n${persona.description ?? persona.prompt}`;
}
