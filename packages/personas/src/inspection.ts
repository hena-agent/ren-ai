import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePersona } from "./model.ts";
import type { PersonaRecord } from "./model.ts";
import { legacyPersonaDraft } from "./legacy.ts";

export type PersonaFileInspection =
  | {
      readonly id: string;
      readonly persona: PersonaRecord;
      readonly error?: never;
      readonly legacySource?: string;
    }
  | {
      readonly id: string;
      readonly error: "invalid_persona_file";
      readonly persona?: never;
      readonly causeName: string;
      readonly causeCode?: string;
      readonly stack: string;
      readonly durationMs: number;
    };

export async function inspectPersonaFiles(
  directory: string,
): Promise<readonly PersonaFileInspection[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".md")).toSorted();
  return Promise.all(
    names.map(async (name): Promise<PersonaFileInspection> => {
      const id = name.slice(0, -3);
      const started = performance.now();
      let source = "";
      try {
        source = await readFile(join(directory, name), "utf8");
        return { id, persona: parsePersona(id, source) };
      } catch (cause) {
        try {
          return { id, persona: legacyPersonaDraft(id, source), legacySource: source };
        } catch {
          /* Continue with the safe file diagnostic. */
        }
        const error = cause instanceof Error ? cause : new Error("Persona file failure");
        const root = error.cause instanceof Error ? error.cause : error;
        return {
          id,
          error: "invalid_persona_file",
          causeName: root.name.slice(0, 100),
          ...("code" in root &&
            typeof root.code === "string" && { causeCode: root.code.slice(0, 100) }),
          stack: (root.stack ?? "")
            .split("\n")
            .filter((line) => /^\s+at /.test(line))
            .join("\n")
            .slice(0, 1000),
          durationMs: performance.now() - started,
        };
      }
    }),
  );
}
