import { Message, ToolResultPart } from "@opencode/ai";
import { Plugin } from "@opencode/plugin/effect";
import { Clock, Effect } from "effect";
import {
  configuredPlugin,
  getPersona,
  inPersonaLocation,
  isMessagingTool,
  type PersonaPluginOptions,
} from "@ren-ai/plugin-application";
import { phone } from "@ren-ai/plugin-application/phone";
import { cleanContext } from "./clean.ts";

export const contextPlugin = (options: PersonaPluginOptions) =>
  Plugin.define({
    id: "ren-ai.context",
    effect: (ctx) =>
      Effect.gen(function* () {
        if (!inPersonaLocation(ctx.location.directory, options.personaDirectory)) return;
        yield* ctx.session.hook("context", (event) =>
          Effect.gen(function* () {
            const persona = yield* getPersona(options, event.agent, ctx.location.directory);
            if (!persona) return;
            const now = yield* Clock.currentTimeMillis;
            const status = yield* (
              options.lastMessageStatus?.(event.sessionID) ?? Effect.succeed(undefined)
            );
            const state = status?.readAt ?? (status?.delivered ? "delivered" : "sent");
            const removed = cleanContext(
              event,
              phone(now, persona.timeZone, state),
              new Set(
                (["send", "read", "react", "wait"] as const).filter(
                  (name) => options[name] && isMessagingTool(name, event.tools[name]),
                ),
              ),
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
      }),
  });

export default configuredPlugin("ren-ai.context", contextPlugin);
