import { Message, ToolResultPart } from "@opencode/ai";
import { Plugin } from "@opencode/plugin/effect";
import { Tool } from "@opencode/schema/tool";
import { Clock, Effect, Schema } from "effect";
import type { Persona } from "../personas/personas.ts";
import { tapbacks, type Tapback } from "../outbox/outbox.ts";
import type { OutgoingStatus } from "../messages/messages.ts";
import { phone } from "../transcript/transcript.ts";
import { cleanContext } from "./context.ts";

interface PluginConfig {
  readonly personaDirectory: string;
  readonly personas: ReadonlyMap<string, Persona>;
  readonly handleForSession: (sessionID: string) => Effect.Effect<string | undefined, Error>;
  readonly read?: (sessionID: string) => Effect.Effect<string, Error>;
  readonly react?: (
    sessionID: string,
    tapback: Tapback,
    callID: string,
  ) => Effect.Effect<string, Error>;
  readonly onContext?: (sessionID: string) => Effect.Effect<void, Error>;
  readonly lastMessageStatus?: (
    sessionID: string,
  ) => Effect.Effect<OutgoingStatus | undefined, Error>;
  readonly health: { readonly raise: (name: string, detail: string) => Effect.Effect<void> };
  readonly settledSends?: (sessionID: string) => Effect.Effect<
    ReadonlyArray<{
      readonly toolCallID: string | null;
      readonly state: string;
      readonly updatedAt: number;
    }>,
    Error
  >;
}

type HostTools =
  | {
      readonly send: (
        sessionID: string,
        text: string,
        callID: string,
      ) => Effect.Effect<string, Error>;
      readonly wait: (sessionID: string, minutes: number) => Effect.Effect<string, Error>;
    }
  | { readonly send?: undefined; readonly wait?: undefined };

export type PersonaPluginOptions = PluginConfig & HostTools;

const toolResult = (action: Effect.Effect<string, Error>) =>
  action.pipe(
    Effect.map((output) => ({ output, content: output })),
    Effect.mapError((error) => new Tool.Error({ message: error.message })),
  );

/** Installed in the persona location; all effects use the public plugin API. */
export const personaPlugin = (options: PersonaPluginOptions) =>
  Plugin.define({
    id: "personas",
    effect: (ctx) =>
      Effect.gen(function* () {
        if (ctx.location.directory !== options.personaDirectory) return;
        yield* ctx.agent.transform((editor) => {
          for (const persona of options.personas.values()) {
            editor.update(persona.id, (agent) => {
              agent.system = persona.prompt;
              agent.description = persona.openingLine;
              agent.permissions = [{ action: "*", resource: "*", effect: "deny" }];
            });
          }
        });
        if (options.send) {
          const send = options.send;
          const wait = options.wait;
          yield* ctx.tool.transform((editor) => {
            editor.add({
              name: "send",
              description: "Send one iMessage bubble to this Conversation's User",
              input: Schema.Struct({ text: Schema.String }),
              output: Schema.String,
              options: { codemode: false },
              execute: ({ text }, context) => toolResult(send(context.sessionID, text, context.id)),
            });
            editor.add({
              name: "wait",
              description: "Pause for up to 12 hours, or until something new arrives",
              // The compiled CLI has its own Effect instance; never share its private AST sentinels.
              input: {
                "~standard": Schema.toStandardJSONSchemaV1(
                  Schema.toStandardSchemaV1(
                    Schema.Struct({ minutes: Schema.Number.check(Schema.isGreaterThan(0)) }),
                  ),
                )["~standard"],
              },
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
              description: "Mark this Conversation's messages read now",
              input: Schema.Record(Schema.String, Schema.Never),
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
              description: "React to his latest message with a standard tapback",
              input: Schema.Struct({ tapback: Schema.Literals(tapbacks) }),
              output: Schema.String,
              options: { codemode: false },
              execute: ({ tapback }, context) =>
                toolResult(react(context.sessionID, tapback, context.id)),
            }),
          );
        }
        yield* ctx.session.hook("context", (event) =>
          Effect.gen(function* () {
            const persona = options.personas.get(event.agent);
            if (!persona) return;
            const now = yield* Clock.currentTimeMillis;
            const status = yield* (
              options.lastMessageStatus?.(event.sessionID) ?? Effect.succeed(undefined)
            );
            const state = status?.readAt ?? (status?.delivered ? "delivered" : "sent");
            const removed = cleanContext(
              event,
              persona.prompt,
              phone(now, persona.timeZone, state),
              new Set((["send", "read", "react", "wait"] as const).filter((name) => options[name])),
            );
            if (options.settledSends) {
              const sends = yield* options.settledSends(event.sessionID);
              for (const [index, entry] of event.messages.entries()) {
                const content = entry.content.map((part) => {
                  if (part.type === "tool-result") {
                    const send = sends.find((row) => row.toolCallID === part.id);
                    if (send) {
                      const at = new Intl.DateTimeFormat("en-GB", {
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZone: persona.timeZone,
                      }).format(send.updatedAt);
                      return ToolResultPart.make({
                        id: part.id,
                        name: part.name,
                        namespace: part.namespace,
                        providerExecuted: part.providerExecuted,
                        cache: part.cache,
                        metadata: part.metadata,
                        providerMetadata: part.providerMetadata,
                        result:
                          send.state === "failed"
                            ? "not sent: earlier send did not go out"
                            : `${send.state} ${at} (confirmed late)`,
                        resultType: "text",
                      });
                    }
                  }
                  return part;
                });
                event.messages[index] = Message.make({
                  id: entry.id,
                  role: entry.role,
                  content,
                  metadata: entry.metadata,
                  providerMetadata: entry.providerMetadata,
                  native: entry.native,
                });
              }
            }
            if (options.onContext) yield* options.onContext(event.sessionID);
            yield* Effect.forEach(removed, (name) =>
              options.health.raise("unexpected-tool", `OpenCode offered disallowed tool: ${name}`),
            );
          }).pipe(Effect.orDie),
        );
        yield* ctx.session.hook("compaction", (event) =>
          Effect.gen(function* () {
            const persona = options.personas.get(event.agent);
            if (!persona) return;
            const { text: summary } = yield* ctx.session.generate({
              sessionID: event.sessionID,
              prompt: `${persona.memory}\nWrite her Memory in ${persona.language}, from her point of view. Use four parts: about him, the two of them, plans and promises, and lately. Preserve his name once learned, even through later summaries. Describe photos worth remembering. Update any previous Memory with what happened since; never discard lasting facts just because they are old. Return only the four-part Memory, not a conversation checkpoint wrapper. Do not call tools.`,
            });
            if (!summary.trim()) yield* Effect.fail(new Error());
            event.result = { summary };
          }).pipe(Effect.orDie),
        );
        yield* ctx.session.hook("title", (event) =>
          Effect.gen(function* () {
            const handle = yield* options.handleForSession(event.sessionID);
            if (!handle) return;
            const session = yield* ctx.session.get({ sessionID: event.sessionID });
            const persona = session.agent!;
            event.result = `${persona[0]!.toUpperCase()}${persona.slice(1)} · ${handle}`;
          }).pipe(Effect.orDie),
        );
      }),
  });
