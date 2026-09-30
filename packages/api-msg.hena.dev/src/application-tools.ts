import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { migrate } from "./database.ts";
import { conversations, type Conversation } from "./conversations/conversations.ts";
import { outbox, type Tapback } from "./outbox/outbox.ts";
import { timing } from "./timing/timing.ts";
import { notReacted } from "./transcript/transcript.ts";
import type { Persona } from "./personas/personas.ts";
import type { Messages } from "./messages/messages.ts";
import type { Gestures } from "./gestures/gestures.ts";
import type { PersonaPluginOptions } from "./opencode/plugin.ts";

export type MessagingTools = {
  readonly [
    Key in Exclude<keyof PersonaPluginOptions, "personaDirectory" | "health">
  ]-?: NonNullable<PersonaPluginOptions[Key]>;
};

/** Preparing callbacks does not start intake, scheduling, or OpenCode execution. */
export const prepareMessaging = (
  personas: ReadonlyMap<string, Persona>,
  messages: Messages,
  gestures: Gestures,
) =>
  Effect.gen(function* () {
    yield* migrate;
    const sql = yield* SqlClient.SqlClient;
    const directory = yield* conversations;
    const pace = timing();
    const sends = yield* outbox(messages, gestures, personas, directory.active, pace);
    const seenAtRequest = new Map<string, string | undefined>();
    const inConversation = (
      sessionID: string,
      action: (conversation: Conversation) => Effect.Effect<string, Error>,
    ) =>
      directory.bySession(sessionID).pipe(
        Effect.flatMap((conversation) =>
          conversation
            ? action(conversation)
            : Effect.fail(new Error("No Conversation for session")),
        ),
        Effect.mapError((error) => new Error(String(error))),
      );
    const tools: MessagingTools = {
      personas,
      handleForSession: (sessionID) =>
        directory.bySession(sessionID).pipe(
          Effect.map((conversation) => (conversation ? conversation.handle : undefined)),
          Effect.orDie,
        ),
      send: (sessionID, text, callID) =>
        inConversation(sessionID, (conversation) => sends.send(conversation, text, callID)),
      wait: (sessionID, minutes) =>
        inConversation(sessionID, (conversation) => pace.wait(conversation.sessionID, minutes)),
      onContext: (sessionID) =>
        Effect.gen(function* () {
          const seen = yield* sql<{
            guid: string;
          }>`SELECT guid FROM intake_seen WHERE session_id = ${sessionID} ORDER BY rowid DESC LIMIT 1`;
          seenAtRequest.set(sessionID, seen[0]?.guid);
        }),
      read: (sessionID) =>
        Effect.gen(function* () {
          const conversation = yield* directory.bySession(sessionID);
          if (!conversation) return yield* Effect.fail(new Error("No Conversation for session"));
          return yield* gestures.read(conversation.handle).pipe(
            Effect.as("read"),
            Effect.catch((error) => Effect.succeed(`not read: ${error.message}`)),
          );
        }).pipe(Effect.mapError((error) => new Error(String(error)))),
      react: (sessionID, tapback: Tapback, callID) =>
        Effect.gen(function* () {
          const conversation = yield* directory.bySession(sessionID);
          if (!conversation) return notReacted("no Conversation for session");
          return yield* sends.react(conversation, tapback, callID, seenAtRequest.get(sessionID));
        }).pipe(Effect.mapError((error) => new Error(String(error)))),
      lastMessageStatus: (sessionID) =>
        directory
          .bySession(sessionID)
          .pipe(
            Effect.flatMap((conversation) =>
              conversation
                ? messages.lastOutgoingStatus(conversation.handle)
                : Effect.succeed(undefined),
            ),
          ),
      settledSends: (sessionID) => sends.results(sessionID),
    };
    return { tools, directory, pace, sends };
  });
