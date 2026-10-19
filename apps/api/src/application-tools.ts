import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { migrate } from "./database.ts";
import { conversations, type Conversation } from "./conversations/conversations.ts";
import { outbox, type Tapback } from "./outbox/outbox.ts";
import { timing } from "./timing/timing.ts";
import { notReacted } from "./transcript/transcript.ts";
import type { Persona } from "@ren-ai/personas";
import type { Messages, Gestures } from "@ren-ai/imsg";
import type { PersonaPluginOptions } from "@ren-ai/plugin-application";
import { conversationEndings } from "./conversations/end.ts";
import { scheduleWork } from "./scheduling.ts";
import { promptID } from "./intake/message-id.ts";

export type MessagingTools = {
  readonly [
    Key in Exclude<keyof PersonaPluginOptions, "personaDirectory" | "health">
  ]-?: NonNullable<PersonaPluginOptions[Key]>;
} & { readonly observe: (sessionID: string) => Effect.Effect<void, Error> };

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
    const pace = yield* timing;
    const sends = yield* outbox(messages, gestures, personas, directory.active, pace);
    const endings = yield* conversationEndings(directory, sends, messages, gestures, personas);
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
      observe: (sessionID) =>
        scheduleWork(`turn:${sessionID}`, Date.now()).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
      personas,
      endConversation: endings.end,
      handleForSession: (sessionID) =>
        directory.bySession(sessionID).pipe(
          Effect.map((conversation) => (conversation ? conversation.handle : undefined)),
          Effect.orDie,
        ),
      send: (sessionID, text, callID) =>
        inConversation(sessionID, (conversation) => sends.send(conversation, text, callID)),
      wait: (sessionID, seconds) =>
        inConversation(sessionID, (conversation) => pace.wait(conversation.sessionID, seconds)),
      context: (sessionID, messageIDs) =>
        Effect.gen(function* () {
          yield* pace.seen(sessionID, messageIDs);
          const seen = yield* sql<{
            guid: string;
          }>`SELECT guid FROM intake_seen WHERE session_id = ${sessionID} ORDER BY rowid DESC LIMIT 1`;
          const guid = seen[0]?.guid;
          const observed = guid && messageIDs.includes(promptID(sessionID, guid)) ? guid : null;
          yield* sql`INSERT INTO context_seen (session_id, guid) VALUES (${sessionID}, ${observed})
            ON CONFLICT(session_id) DO UPDATE SET guid = excluded.guid WHERE guid IS NOT excluded.guid`;
          const conversation = yield* directory.bySession(sessionID);
          if (conversation) yield* sends.observe(conversation);
          return {
            status: conversation
              ? yield* messages.lastOutgoingStatus(conversation.handle)
              : undefined,
            sends: yield* sends.results(sessionID),
          };
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
          const [seen] = yield* sql<{
            guid: string | null;
          }>`SELECT guid FROM context_seen WHERE session_id = ${sessionID}`;
          return yield* sends.react(conversation, tapback, callID, seen?.guid ?? undefined);
        }).pipe(Effect.mapError((error) => new Error(String(error)))),
    };
    return { tools, directory, pace, sends, endings };
  });
