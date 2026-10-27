import { Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";
import { Schema } from "effect";
import { personaMemory, memoryTools, memoryToolNames } from "@ren-ai/plugin-session-folder/memory";
import { managedFolder } from "@ren-ai/plugin-session-folder/paths";
import {
  personaAdjustments,
  adjustmentTool,
  appendAdjustmentInstructions,
} from "@ren-ai/plugin-session-folder/adjustments";
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
        yield* ctx.tool.transform((editor) => {
          editor.add({
            name: "review_adjustments",
            description: adjustmentTool.description,
            input: {
              "~standard": Schema.toStandardJSONSchemaV1(
                Schema.toStandardSchemaV1(adjustmentTool.input),
              )["~standard"],
            },
            output: Schema.String,
            options: { codemode: false },
            execute: (input, context) =>
              conversationTool("review_adjustments", context.sessionID, context.id, () =>
                personaAdjustments(ctx.location.directory, context.sessionID).run(
                  input,
                  context.id,
                ),
              ).pipe(Effect.annotateLogs({ stage: "review" })),
          });
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
                  return personaMemory(ctx.location.directory, context.sessionID).run(
                    name,
                    input,
                    context.id,
                    context.messageID,
                  );
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
              () => personaMemory(ctx.location.directory, event.sessionID).context(false),
            );
            const adjustments = yield* conversationOperation(
              "adjustments.compaction.context",
              event.sessionID,
              () => personaAdjustments(ctx.location.directory, event.sessionID).context(),
            );
            appendAdjustmentInstructions(event.system, ctx.location.directory, adjustments);
            // Let OpenCode execute and account for compaction instead of an unmetered session.generate.
            // Its validator requires a native heading; the content remains first-person Persona Memory.
            event.system.push({
              type: "text",
              text: "This is Persona Memory, not a coding task. Follow the four-part first-person Memory instructions in the conversation. Use only ## Important Context as the enclosing heading; ignore the generic coding checkpoint template appended later.",
            });
            event.messages.push({
              role: "user",
              content: [
                {
                  type: "text",
                  text: `${persona.memory}\nWrite her Memory in ${persona.language}, from her point of view. Use four parts: about him, the two of them, plans and promises, and lately, under ## Important Context. Current shared State and Life memory, this Conversation's Relationship state and Relationship memory, and memory-clarity override older summaries and tool results. Keep the two scopes distinct; another Conversation's shared-life changes are not this user's doing, and private relationship facts never become Life memory. Preserve known facts and unfinished promises, but omit forgotten details and keep faded memories uncertain; never reconstruct lost details from old transcript or tool results. Describe photos worth remembering, including her own; distinguish photos merely taken from confirmed sends. Update any previous Memory with what happened since. This summary is a conversation checkpoint, not a replacement for the persistent short-term or long-term files. Do not call tools.\n\n${current}`,
                },
              ],
            });
            event.tools = {};
          }).pipe(Effect.orDie),
        );
      }),
  });

export default configuredPlugin("ren-ai.memory", memoryPlugin);
