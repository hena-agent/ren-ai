import { Schema } from "effect";
import { PersonaError } from "./model.ts";

export const PersonaVersion = Schema.Struct({
  version: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  markdown: Schema.String,
  createdAt: Schema.Number,
  restoredFrom: Schema.NullOr(Schema.Number),
});
export type PersonaVersion = typeof PersonaVersion.Type;
export type VersionSummary = Omit<PersonaVersion, "markdown">;
export type SaveSnapshot = {
  persona: string;
  initial?: { state: string; memory: string };
  legacySource?: string;
  restoredFrom?: number;
};

export function nextPersonaVersion(
  previous: { version?: number; description?: string; prompt: string } | undefined,
  markdown: string,
  restoredFrom?: number,
) {
  if (!previous) return 1;
  return (
    (previous.version ?? 1) +
    Number(
      restoredFrom !== undefined ||
        (previous.description ?? previous.prompt).replace(/\r\n?/g, "\n").trim() !==
          markdown.replace(/\r\n?/g, "\n").trim(),
    )
  );
}

export function requireVersion(versions: readonly PersonaVersion[], version: number) {
  const found = versions.find((entry) => entry.version === version);
  if (!found) throw new PersonaError("not_found", "페르소나 버전을 찾을 수 없습니다.");
  return found;
}
