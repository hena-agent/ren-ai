import { Plugin } from "@opencode/plugin/effect";
import { Tool } from "@opencode/schema/tool";
import { Effect, Schema } from "effect";
import {
  configuredPlugin,
  inPersonaLocation,
  messagingToolDefinitions,
  type PersonaPluginOptions,
  type PhotoResult,
} from "@ren-ai/plugin-application";

const toolResult = (action: Effect.Effect<string, Error>) =>
  action.pipe(
    Effect.map((output) => ({ output, content: output })),
    Effect.mapError((error) => new Tool.Error({ message: error.message })),
  );

const photoContent = (result: PhotoResult): Tool.Result<typeof Schema.String> => {
  if (result.status === "declined") return { output: "declined", content: "declined" };
  const output = JSON.stringify({
    status: result.status,
    photo: result.photo,
    expiresAt: result.expiresAt,
  });
  return {
    output,
    content: [
      { type: "text", text: output },
      { type: "file", uri: `data:image/jpeg;base64,${result.data}`, mime: "image/jpeg" },
    ],
  };
};

export const toolsPlugin = (options: PersonaPluginOptions) =>
  Plugin.define({
    id: "ren-ai.tools",
    effect: (ctx) =>
      Effect.gen(function* () {
        if (!inPersonaLocation(ctx.location.directory, options.personaDirectory)) return;
        if (options.takePhoto) {
          const take = options.takePhoto;
          yield* ctx.tool.transform((editor) =>
            editor.add({
              name: "take_photo",
              ...messagingToolDefinitions.take_photo,
              output: Schema.String,
              options: { codemode: false },
              execute: (input, context) =>
                options.handleForSession(context.sessionID).pipe(
                  Effect.flatMap((handle) =>
                    handle === undefined
                      ? Effect.succeed<PhotoResult>({ status: "declined" })
                      : take(context.sessionID, input, context.id),
                  ),
                  Effect.map(photoContent),
                  Effect.mapError((error) => new Tool.Error({ message: error.message })),
                ),
            }),
          );
        }
        if (options.sendPhoto) {
          const send = options.sendPhoto;
          yield* ctx.tool.transform((editor) =>
            editor.add({
              name: "send_photo",
              ...messagingToolDefinitions.send_photo,
              output: Schema.String,
              options: { codemode: false },
              execute: ({ photo }, context) =>
                toolResult(
                  options
                    .handleForSession(context.sessionID)
                    .pipe(
                      Effect.flatMap((handle) =>
                        handle === undefined
                          ? Effect.succeed("not sent: unavailable")
                          : send(context.sessionID, photo, context.id),
                      ),
                    ),
                ),
            }),
          );
        }
        if (options.endConversation) {
          const end = options.endConversation;
          yield* ctx.tool.transform((editor) =>
            editor.add({
              name: "end_conversation",
              ...messagingToolDefinitions.end_conversation,
              output: Schema.String,
              options: { codemode: false },
              execute: ({ farewell }, context) =>
                toolResult(end(context.sessionID, farewell, context.id)),
            }),
          );
        }
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
              execute: ({ seconds }, context) => toolResult(wait(context.sessionID, seconds)),
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
