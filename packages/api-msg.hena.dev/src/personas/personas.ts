import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { parseDocument } from "yaml";

const Frontmatter = Schema.Struct({
  "time-zone": Schema.String,
  language: Schema.String,
  "opening-line": Schema.String,
  memory: Schema.String,
});

export interface Persona {
  readonly id: string;
  readonly timeZone: string;
  readonly language: string;
  readonly openingLine: string;
  readonly memory: string;
  readonly prompt: string;
}

/** The only boundary at which the untrusted YAML enters the application. */
function parsePersona(id: string, source: string): Persona {
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
  if (!Object.values(fields).every((value) => value.trim()) || !match[2]!.trim()) {
    throw new Error(`Persona ${id}: frontmatter and prompt must not be empty`);
  }
  try {
    Intl.DateTimeFormat("en", { timeZone: fields["time-zone"] }).resolvedOptions();
  } catch {
    throw new Error(`Persona ${id}: invalid time-zone: ${fields["time-zone"]}`);
  }
  return {
    id,
    timeZone: fields["time-zone"],
    language: fields.language,
    openingLine: fields["opening-line"],
    memory: fields.memory,
    prompt: match[2]!,
  };
}

export const loadPersonas = (directory: string) =>
  Effect.gen(function* () {
    const names = (yield* Effect.tryPromise(() => readdir(directory))).filter((name) =>
      name.endsWith(".md"),
    );
    if (!names.length) return yield* Effect.fail(new Error(`No persona files in ${directory}`));
    const personas = yield* Effect.forEach(names.toSorted(), (name) =>
      Effect.map(
        Effect.tryPromise(() =>
          readFile(join(directory, name)).then((bytes) => bytes.toString("utf8")),
        ),
        (source) => parsePersona(name.slice(0, -3), source),
      ),
    );
    return new Map(personas.map((persona) => [persona.id, persona]));
  });
