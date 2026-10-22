import { isDeepStrictEqual } from "node:util";
import { Schema, type JsonSchema } from "effect";
import { readRuntime as readStoredRuntime, lockedMemory } from "./memory-files.ts";
import {
  runtimeDocuments,
  memoryTools,
  memoryToolNames,
  type RuntimeSnapshot,
} from "./memory-model.ts";
import { readState, readShortTerm } from "./memory-markdown.ts";

export { memoryTools, memoryToolNames, runtimeDocuments, lockedMemory };
export { personaMemory } from "./memory-persona.ts";
export type { RuntimeSnapshot } from "./memory-model.ts";

export const runtimeFromDocuments = (
  documents: { state: string; memory: string } | undefined,
): RuntimeSnapshot => ({
  additional: {},
  shortTerm: "",
  longTerm: [],
  receipts: {},
  ...(documents && { ...readState(documents.state), ...readShortTerm(documents.memory) }),
});

export const readRuntime = (directory: string) =>
  lockedMemory(directory, () => readStoredRuntime(directory));

export const isMemoryTool = (
  name: string,
  tool: { description: string; input: JsonSchema.JsonSchema } | undefined,
) =>
  memoryToolNames.some(
    (key) =>
      name === key &&
      tool?.description === memoryTools[key].description &&
      isDeepStrictEqual(
        tool.input,
        Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(memoryTools[key].input))[
          "~standard"
        ].jsonSchema.input({ target: "draft-2020-12" }),
      ),
  );
