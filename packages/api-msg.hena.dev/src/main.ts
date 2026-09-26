import { Effect, Layer } from "effect";
import { loadPersonas } from "./personas/personas.ts";
import { isolatedHost } from "./opencode/isolate.ts";
import type { HostOptions, PersonaHostOptions } from "./opencode/host.ts";
export { serveViewer, viewerFront } from "./opencode/viewer.ts";

export { makeHealth } from "./health/health.ts";
export { makeBackup } from "./backup/backup.ts";
import { migrate } from "./database.ts";
import { conversations } from "./conversations/conversations.ts";
import type { Conversation } from "./conversations/conversations.ts";
import { outbox } from "./outbox/outbox.ts";
import type { Messages } from "./messages/messages.ts";
import type { Gestures } from "./gestures/gestures.ts";
import { intake } from "./intake/intake.ts";
import { timing } from "./timing/timing.ts";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";

export const startPersonaHost = (root: string, options: PersonaHostOptions) =>
  Effect.flatMap(loadPersonas(options.personaDirectory), (personas) =>
    isolatedHost(root, { ...options, personas }),
  );

export const startMessagingHost = (
  root: string,
  options: Omit<HostOptions, "personas" | "send" | "wait" | "handleForSession">,
  messages: Messages,
  gestures: Gestures,
) =>
  Effect.gen(function* () {
    yield* migrate;
    const directory = yield* conversations;
    const pace = timing();
    const sends = yield* outbox(messages, gestures, pace);
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
    const host = yield* startPersonaHost(root, {
      ...options,
      handleForSession: (sessionID) =>
        directory.bySession(sessionID).pipe(
          Effect.map((conversation) => (conversation ? conversation.handle : undefined)),
          Effect.orDie,
        ),
      send: (sessionID, text, callID) =>
        inConversation(sessionID, (conversation) => sends.send(conversation, text, callID)),
      wait: (sessionID, minutes) =>
        inConversation(sessionID, (conversation) => pace.wait(conversation.id, minutes)),
    });
    const incoming = yield* intake(
      messages,
      (handle) => directory.byHandle(handle),
      (sessionID, id, text) =>
        host.sessions
          .prompt({ sessionID: Session.ID.make(sessionID), id: SessionMessage.ID.make(id), text })
          .pipe(Effect.asVoid),
      (personaID) => host.personas.get(personaID)!.timeZone,
    );
    incoming.onNew((conversation) => pace.onNew(conversation.id));
    return { ...host, conversations: directory, intake: incoming };
  });

/** Production opens the server's own file, never OpenCode's database. */
export const startMessagingServer = (
  root: string,
  options: Omit<HostOptions, "personas" | "send" | "wait" | "handleForSession">,
  databaseFile: string,
  messages: Messages,
  gestures: Gestures,
) =>
  Effect.gen(function* () {
    const { SqliteClient } = yield* Effect.promise(() => import("@effect/sql-sqlite-bun"));
    const database = yield* Layer.build(
      SqliteClient.layer({ filename: databaseFile, busyTimeout: "5 seconds" }),
    );
    return yield* startMessagingHost(root, options, messages, gestures).pipe(
      Effect.provide(database),
    );
  });
