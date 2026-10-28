import { ToolResultPart, type Message } from "@opencode/ai/effect";
import { Plugin } from "@opencode/plugin/effect";
import type { SessionContext } from "@opencode/plugin/effect/session";
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
import {
  personaAdjustments,
  isAdjustmentTool,
  appendAdjustmentInstructions,
} from "@ren-ai/plugin-session-folder/adjustments";

const latestInput = (messages: ReadonlyArray<Message>) =>
  messages.findLast(
    (message) =>
      message.role === "user" &&
      message.id !== undefined &&
      !message.content.some(
        (part) => part.type === "text" && /<checked-phone(?:\s|>)/.test(part.text),
      ),
  )?.id;

const messagingTools = (
  options: PersonaPluginOptions,
  tools: Readonly<Record<string, Parameters<typeof isMessagingTool>[1]>>,
) =>
  (
    [
      ["send", options.send],
      ["read", options.read],
      ["react", options.react],
      ["wait", options.wait],
      ["take_photo", options.takePhoto],
      ["send_photo", options.sendPhoto],
      ["end_conversation", options.endConversation],
    ] as const
  ).flatMap(([name, action]) => (action && isMessagingTool(name, tools[name]) ? [name] : []));

type Snapshot = Effect.Success<ReturnType<NonNullable<PersonaPluginOptions["context"]>>>;

const allowedTools = (options: PersonaPluginOptions, tools: SessionContext["tools"]) =>
  new Set([
    "websearch",
    ...messagingTools(options, tools),
    ...(isDiceTool(tools["dice"]) ? ["dice"] : []),
    ...(isAdjustmentTool(tools["review_adjustments"]) ? ["review_adjustments"] : []),
    ...memoryToolNames.filter((name) => isMemoryTool(name, tools[name])),
  ]);

const applySnapshot = (event: SessionContext, snapshot: Snapshot, timeZone: string) => {
  if (snapshot.startingRelationship)
    event.system.push({
      type: "text",
      text: `<starting-relationship>${snapshot.startingRelationship}</starting-relationship>\nThis is the chosen starting relationship, not knowledge of the user's life or shared history. Follow the current relationship established in this Conversation's Memory.`,
    });
  for (const [index, entry] of event.messages.entries()) {
    const content = entry.content.map((part) => {
      if (part.type !== "tool-result") return part;
      const send = snapshot.sends.find((row) => row.toolCallID === part.id);
      if (!send) return part;
      const at = new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone,
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
};

export const contextPlugin = (options: PersonaPluginOptions) =>
  Plugin.define({
    id: "ren-ai.context",
    effect: (ctx) =>
      Effect.gen(function* () {
        if (!inPersonaLocation(ctx.location.directory, options.personaDirectory)) return;
        yield* ctx.session.hook(
          "context",
          Effect.fnUntraced(function* (event: SessionContext) {
            const persona = yield* getPersona(options, event.agent, ctx.location.directory);
            if (!persona) return;
            const snapshot = yield* (
              options.context?.(
                event.sessionID,
                event.messages.flatMap((entry) => entry.id ?? []),
              ) ?? Effect.succeed(undefined)
            );
            const status = snapshot?.status;
            const state = status?.readAt ?? (status?.delivered ? "delivered" : "sent");
            const now = yield* Clock.currentTimeMillis;
            const removed = cleanContext(
              event,
              phone(now, persona.timeZone, state),
              allowedTools(options, event.tools),
            );
            if (managedFolder(options.personaDirectory, ctx.location.directory)) {
              const latestMessageID = latestInput(event.messages);
              const adjustments = yield* conversationOperation(
                "adjustments.context",
                event.sessionID,
                () =>
                  personaAdjustments(ctx.location.directory, event.sessionID).context(
                    latestMessageID,
                    now,
                  ),
              );
              appendAdjustmentInstructions(event.system, ctx.location.directory, adjustments);
              const memory = yield* conversationOperation("memory.context", event.sessionID, () =>
                personaMemory(ctx.location.directory, event.sessionID).context(),
              );
              event.system.push({ type: "text", text: memory });
            }
            if (snapshot) applySnapshot(event, snapshot, persona.timeZone);
            yield* Effect.forEach(removed, (name) =>
              options.health.raise("unexpected-tool", `OpenCode offered disallowed tool: ${name}`),
            );
          }, Effect.orDie),
        );
      }),
  });

export default configuredPlugin("ren-ai.context", contextPlugin);
