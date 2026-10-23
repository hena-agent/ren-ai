import { ToolResultPart } from "@opencode/ai";
import { Plugin } from "@opencode/plugin/effect";
import { Clock, Effect } from "effect";
import {
  configuredPlugin,
  getPersona,
  inPersonaLocation,
  isMessagingTool,
  type PersonaPluginOptions,
  conversationOperation,
} from "@ren-ai/plugin-application";
import { phone } from "@ren-ai/plugin-application/phone";
import { isDiceTool } from "@ren-ai/plugin-dice";
import { cleanContext } from "./clean.ts";
import { personaMemory, memoryToolNames, isMemoryTool } from "@ren-ai/plugin-session-folder/memory";
import { managedFolder } from "@ren-ai/plugin-session-folder/paths";

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
            const snapshot = yield* (
              options.context?.(
                event.sessionID,
                event.messages.flatMap((entry) => entry.id ?? []),
              ) ?? Effect.succeed(undefined)
            );
            const status = snapshot?.status;
            const state = status?.readAt ?? (status?.delivered ? "delivered" : "sent");
            const removed = cleanContext(
              event,
              phone(now, persona.timeZone, state),
              new Set([
                ...(["send", "read", "react", "wait"] as const).filter(
                  (name) => options[name] && isMessagingTool(name, event.tools[name]),
                ),
                ...(options.endConversation &&
                isMessagingTool("end_conversation", event.tools["end_conversation"])
                  ? ["end_conversation"]
                  : []),
                ...(isDiceTool(event.tools["dice"]) ? ["dice"] : []),
                ...memoryToolNames.filter((name) => isMemoryTool(name, event.tools[name])),
              ]),
            );
            if (managedFolder(options.personaDirectory, ctx.location.directory)) {
              const memory = yield* conversationOperation("memory.context", event.sessionID, () =>
                personaMemory(ctx.location.directory, event.sessionID).context(),
              );
              event.system.push({ type: "text", text: memory });
            }
            if (snapshot) {
              if (snapshot.startingRelationship)
                event.system.push({
                  type: "text",
                  text: `<starting-relationship>${snapshot.startingRelationship}</starting-relationship>\nThis is the chosen starting relationship, not knowledge of the user's life or shared history. Follow the current relationship established in this Conversation's Memory.`,
                });
              const sends = snapshot.sends;
              for (const [index, entry] of event.messages.entries()) {
                const content = entry.content.map((part) => {
                  if (part.type === "tool-result") {
                    const confirmed = sends.filter(
                      (row) =>
                        row.toolCallID === part.id ||
                        row.toolCallID?.startsWith(`${part.id}:bubble:`),
                    );
                    if (confirmed.length) {
                      const original =
                        typeof part.result.value === "string" &&
                        part.result.value.startsWith("Bubble ")
                          ? `${part.result.value}\nUpdated outcomes (override the corresponding earlier bubble results):\n`
                          : "";
                      const result = confirmed
                        .map((send) => {
                          const at = new Intl.DateTimeFormat("en-GB", {
                            hour: "2-digit",
                            minute: "2-digit",
                            timeZone: persona.timeZone,
                          }).format(send.updatedAt);
                          const bubble =
                            send.toolCallID === part.id
                              ? "1"
                              : send.toolCallID!.slice(`${part.id}:bubble:`.length);
                          const outcome =
                            send.state === "failed"
                              ? "not sent: earlier send did not go out"
                              : `${send.state} ${at} (confirmed late)`;
                          return part.name === "send" ? `Bubble ${bubble}: ${outcome}` : outcome;
                        })
                        .join("\n");
                      return ToolResultPart.make({
                        id: part.id,
                        name: part.name,
                        namespace: part.namespace,
                        providerExecuted: part.providerExecuted,
                        cache: part.cache,
                        metadata: part.metadata,
                        providerMetadata: part.providerMetadata,
                        result: `${original}${result}\nOnly the listed outcomes are confirmed; do not repeat completed sends or assume the remaining bubbles went out.`,
                        resultType: "text",
                      });
                    }
                  }
                  return part;
                });
                // Core owns media assets; revalidating with this SDK copy rejects their class identity.
                event.messages[index] = {
                  id: entry.id,
                  role: entry.role,
                  content,
                  metadata: entry.metadata,
                  providerMetadata: entry.providerMetadata,
                  native: entry.native,
                };
              }
            }
            yield* Effect.forEach(removed, (name) =>
              options.health.raise("unexpected-tool", `OpenCode offered disallowed tool: ${name}`),
            );
          }).pipe(Effect.orDie),
        );
      }),
  });

export default configuredPlugin("ren-ai.context", contextPlugin);
