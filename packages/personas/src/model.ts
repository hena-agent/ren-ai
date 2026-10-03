import { Schema } from "effect";
import { parseDocument, stringify } from "yaml";

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
}

export interface PersonaRecord extends Persona {
  readonly name: string;
  readonly bio: string;
  readonly imageUrl: string;
  readonly published: boolean;
}

export class PersonaError extends Error {
  constructor(
    readonly kind: "invalid" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

const Frontmatter = Schema.Struct({
  "time-zone": Schema.String,
  language: Schema.String,
  "opening-line": Schema.String,
  memory: Schema.String,
  name: Schema.optionalKey(Schema.String),
  bio: Schema.optionalKey(Schema.String),
  "image-url": Schema.optionalKey(Schema.String),
  published: Schema.optionalKey(Schema.Boolean),
});

const Input = Schema.Struct({
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
    const persona = Schema.decodeUnknownSync(Input)(input, { onExcessProperty: "error" });
    validateID(persona.id);
    validateRuntime(persona);
    if (!persona.name.trim()) throw new Error("이름을 입력해 주세요.");
    if (persona.imageUrl && new URL(persona.imageUrl).protocol !== "https:") {
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
    bio: fields.bio ?? "",
    imageUrl: fields["image-url"] ?? "",
    published: fields.published ?? false,
  };
  return decodePersona(persona);
}

export function serializePersona(persona: PersonaRecord): string {
  return `---\n${stringify({
    "time-zone": persona.timeZone,
    language: persona.language,
    "opening-line": persona.openingLine,
    memory: persona.memory,
    name: persona.name,
    bio: persona.bio,
    "image-url": persona.imageUrl,
    published: persona.published,
  })}---\n${persona.prompt}`;
}
