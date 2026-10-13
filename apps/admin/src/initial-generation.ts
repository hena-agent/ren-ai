import { Schema } from "effect";
import type { JsonSchema } from "effect";
import {
  InitialScores,
  InitialDocuments,
  initialTraits,
  serializeInitialState,
  validateInitialDocuments,
  validateInitialMemory,
  parseCharacterDescription,
} from "@ren-ai/personas";
import { splitPersonaMarkdown } from "@ren-ai/personas/profile";
import { protect, validationFailure } from "./logging.ts";
import type { LogFields } from "./logging.ts";
import policy from "./initial-policy.json";

export const GeneratedPersona = Schema.Struct({
  persona: Schema.String,
  state: InitialScores,
  memory: InitialDocuments.fields.memory,
});

export function generatedInitial(source: string, state: typeof InitialScores.Type, memory: string) {
  validateInitialMemory(memory);
  return validateInitialDocuments({
    state: serializeInitialState({ ...state, traits: initialTraits(source) }),
    memory: memory.trim() + "\n",
  });
}

export async function generateInitialDocument(
  request: (
    prompt: string,
    input: string,
    schema?: JsonSchema.JsonSchema,
  ) => Promise<{ text: string; fields: LogFields }>,
  source: string,
  target: "state" | "memory",
) {
  parseCharacterDescription(source);
  const schema = target === "state" ? Schema.toJsonSchemaDocument(InitialScores).schema : undefined;
  const response = await request(
    policy[target],
    splitPersonaMarkdown(source).privateMarkdown,
    schema,
  );
  protect(response.text);
  try {
    if (target === "state") {
      const scores = Schema.decodeUnknownSync(InitialScores)(JSON.parse(response.text), {
        onExcessProperty: "error",
      });
      return serializeInitialState({ ...scores, traits: initialTraits(source) });
    }
    const memory =
      Schema.decodeUnknownSync(InitialDocuments.fields.memory)(response.text).trim() + "\n";
    return validateInitialMemory(memory);
  } catch (cause) {
    throw validationFailure(
      "Invalid initial document",
      { ...response.fields, code: "invalid_initial_document" },
      cause,
    );
  }
}
