import { Plugin } from "@opencode/plugin/effect";
import { inPersonaLocation, conversationTool } from "@ren-ai/plugin-application";
import { conversationMemory } from "@ren-ai/plugin-session-folder/memory";
import { managedFolder } from "@ren-ai/plugin-session-folder/paths";
import { Effect, Schema, type JsonSchema } from "effect";
import { isDeepStrictEqual } from "node:util";

const input = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.Never)),
)["~standard"];
const description =
  "Return a random integer from 0 to 10000, inclusive. Call when you want randomness to help choose what to do; no arguments required.";

export const isDiceTool = (
  tool: { readonly description: string; readonly input: JsonSchema.JsonSchema } | undefined,
) =>
  tool?.description === description &&
  isDeepStrictEqual(tool.input, input.jsonSchema.input({ target: "draft-2020-12" }));

export const dicePlugin = (options: { readonly personaDirectory: string }) =>
  Plugin.define({
    id: "ren-ai.dice",
    effect: (ctx) =>
      Effect.gen(function* () {
        if (!inPersonaLocation(ctx.location.directory, options.personaDirectory)) return;
        if (!managedFolder(options.personaDirectory, ctx.location.directory)) return;
        yield* ctx.tool.transform((editor) =>
          editor.add({
            name: "dice",
            description,
            input: { "~standard": input },
            output: Schema.String,
            options: { codemode: false },
            execute: (_, context) =>
              conversationTool("dice", context.sessionID, context.id, async () => {
                if (
                  managedFolder(options.personaDirectory, ctx.location.directory) !==
                  context.sessionID
                )
                  throw new Error("Conversation dice binding mismatch");
                return conversationMemory(ctx.location.directory).roll(
                  context.id,
                  context.messageID,
                );
              }),
          }),
        );
      }),
  });

export default Plugin.define({
  id: "ren-ai.dice",
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ directory: Schema.String }),
      )(ctx.options);
      yield* dicePlugin({ personaDirectory: options.directory }).effect(ctx);
    }).pipe(Effect.orDie),
});
