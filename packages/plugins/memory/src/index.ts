import { Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";
import { Schema } from "effect";
import {
  conversationMemory,
  memoryTools,
  memoryToolNames,
} from "@ren-ai/plugin-session-folder/memory";
import { managedFolder } from "@ren-ai/plugin-session-folder/paths";
import {
  configuredPlugin,
  getPersona,
  type PersonaPluginOptions,
  conversationOperation,
  conversationTool,
} from "@ren-ai/plugin-application";

export const memoryPlugin = (options: PersonaPluginOptions) =>
  Plugin.define({
    id: "ren-ai.memory",
    effect: (ctx) =>
      Effect.gen(function* () {
        const folder = managedFolder(options.personaDirectory, ctx.location.directory);
        if (!folder) return;
        const memory = conversationMemory(ctx.location.directory);
        yield* ctx.tool.transform((editor) => {
          for (const name of memoryToolNames)
            editor.add({
              name,
              description: memoryTools[name].description,
              input: {
                "~standard": Schema.toStandardJSONSchemaV1(
                  Schema.toStandardSchemaV1(memoryTools[name].input),
                )["~standard"],
              },
              output: Schema.String,
              options: { codemode: false },
              execute: (input, context) =>
                conversationTool(name, context.sessionID, context.id, async () => {
                  if (context.sessionID !== folder)
                    throw new Error("Conversation memory binding mismatch");
                  return memory.run(name, input, context.id, context.messageID);
                }),
            });
        });
        yield* ctx.session.hook("compaction", (event) =>
          Effect.gen(function* () {
            // Managed folders always return their validated Persona snapshot; mismatches throw.
            const persona = (yield* getPersona(options, event.agent, ctx.location.directory))!;
            const current = yield* conversationOperation(
              "memory.compaction.context",
              event.sessionID,
              () => memory.context(),
            );
            const { text: summary } = yield* ctx.session.generate({
              sessionID: event.sessionID,
              prompt: `${persona.memory}\nWrite her Memory in ${persona.language}, from her point of view. Use four parts: about him, the two of them, plans and promises, and lately. The current Conversation documents and memory-clarity override older summaries and tool results. Preserve known facts and unfinished promises, but omit forgotten details and keep faded memories uncertain; never reconstruct lost details from old transcript or tool results. Describe photos worth remembering. Update any previous Memory with what happened since. This summary is a conversation checkpoint, not a replacement for the persistent short-term or long-term files. Return only the four-part Memory, not a conversation checkpoint wrapper. Do not call tools.\n\n${current}`,
            });
            if (!summary.trim()) yield* Effect.fail(new Error());
            event.result = { summary };
          }).pipe(Effect.orDie),
        );
      }),
  });

export default configuredPlugin("ren-ai.memory", memoryPlugin);
