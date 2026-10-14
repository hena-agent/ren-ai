import { Schema } from "effect";
import { isBuiltin } from "node:module";

const module = Schema.Struct({ imports: Schema.Array(Schema.Struct({ path: Schema.String })) });
const graph = Schema.fromJsonString(
  Schema.Struct({
    inputs: Schema.Record(Schema.String, module),
    outputs: Schema.Record(Schema.String, module),
  }),
);

/** A replacement Mac gets only a bundle and Bun: no package install or OpenCode. */
export const verifyMacGraph = (contents: string): void => {
  const { inputs, outputs } = Schema.decodeUnknownSync(graph)(contents);
  for (const [path, input] of Object.entries(inputs)) {
    if (path.includes("@opencode")) throw new Error(`OpenCode in Mac artifact: ${path}`);
    for (const item of input.imports) {
      if (item.path.includes("@opencode"))
        throw new Error(`OpenCode in Mac artifact: ${item.path}`);
    }
  }
  // Input barrels list tree-shaken externals; only emitted output imports matter.
  for (const output of Object.values(outputs))
    for (const item of output.imports)
      if (!isBuiltin(item.path) && !item.path.startsWith("bun:"))
        throw new Error(`Unbundled Mac dependency: ${item.path}`);
};
