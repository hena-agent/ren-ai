import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { parsePersona } from "./model.ts";

export const readPersonas = (directory: string) =>
  Effect.gen(function* () {
    const names = (yield* Effect.tryPromise(() => readdir(directory))).filter((name) =>
      name.endsWith(".md"),
    );
    const records = yield* Effect.forEach(names.toSorted(), (name) =>
      Effect.map(
        Effect.tryPromise(() => readFile(join(directory, name)).then((bytes) => bytes.toString())),
        (source) => parsePersona(name.slice(0, -3), source),
      ),
    );
    return new Map(records.map((persona) => [persona.id, persona]));
  });

export const loadPersonas = (directory: string) =>
  Effect.gen(function* () {
    const personas = yield* readPersonas(directory);
    if (!personas.size) return yield* Effect.fail(new Error(`No persona files in ${directory}`));
    return personas;
  });
