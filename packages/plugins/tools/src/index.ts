import { Plugin } from "@opencode/plugin/effect";
import { Tool } from "@opencode/schema/tool";
import { Effect, Schema } from "effect";
import {
  configuredPlugin,
  inPersonaLocation,
  messagingToolDefinitions,
  type PersonaPluginOptions,
} from "@ren-ai/plugin-application";

const toolResult = (action: Effect.Effect<string, Error>) =>
  action.pipe(
    Effect.map((output) => ({ output, content: output })),
    Effect.mapError((error) => new Tool.Error({ message: error.message })),
  );

export const toolsPlugin = (options: PersonaPluginOptions) =>
  Plugin.define({
    id: "ren-ai.tools",
    effect: (ctx) =>
      Effect.gen(function* () {
        if (!inPersonaLocation(ctx.location.directory, options.personaDirectory)) return;
        if (options.send) {
          const send = options.send;
          const wait = options.wait;
          yield* ctx.tool.transform((editor) => {
            editor.add({
              name: "send",
              ...messagingToolDefinitions.send,
              output: Schema.String,
              options: { codemode: false },
              execute: ({ text }, context) => toolResult(send(context.sessionID, text, context.id)),
            });
            editor.add({
              name: "wait",
              ...messagingToolDefinitions.wait,
              output: Schema.String,
              options: { codemode: false },
              execute: ({ minutes }, context) => toolResult(wait(context.sessionID, minutes)),
            });
          });
        }
        if (options.read) {
          const read = options.read;
          yield* ctx.tool.transform((editor) =>
            editor.add({
              name: "read",
              ...messagingToolDefinitions.read,
              output: Schema.String,
              options: { codemode: false },
              execute: (_, context) => toolResult(read(context.sessionID)),
            }),
          );
        }
        if (options.react) {
          const react = options.react;
          yield* ctx.tool.transform((editor) =>
            editor.add({
              name: "react",
              ...messagingToolDefinitions.react,
              output: Schema.String,
              options: { codemode: false },
              execute: ({ tapback }, context) =>
                toolResult(react(context.sessionID, tapback, context.id)),
            }),
          );
        }
      }),
  });

export default configuredPlugin("ren-ai.tools", toolsPlugin);
