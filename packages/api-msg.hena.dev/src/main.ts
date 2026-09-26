import { Effect, Layer } from "effect";
import { loadPersonas } from "./personas/personas.ts";
import { isolatedHost } from "./opencode/isolate.ts";
import type { HostOptions } from "./opencode/host.ts";
export { serveViewer, viewerFront } from "./opencode/viewer.ts";

export { makeHealth } from "./health/health.ts";
export { makeBackup } from "./backup/backup.ts";
import { migrate } from "./database.ts";
import { conversations } from "./conversations/conversations.ts";
import { outbox } from "./outbox/outbox.ts";
import type { Messages } from "./messages/messages.ts";
import type { Gestures } from "./gestures/gestures.ts";
import { intake } from "./intake/intake.ts";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";

export const startPersonaHost = (root: string, options: Omit<HostOptions, "personas">) =>
  Effect.flatMap(loadPersonas(options.personaDirectory), (personas) =>
    isolatedHost(root, { ...options, personas }),
  );

export const startMessagingHost = (
  root: string,
  options: Omit<HostOptions, "personas" | "send" | "handleForSession">,
  messages: Messages,
  gestures: Gestures,
) =>
  Effect.gen(function* () {
    yield* migrate;
    const directory = yield* conversations;
    const personas = yield* loadPersonas(options.personaDirectory);
    const sends = yield* outbox(messages, gestures, personas);
    const host = yield* isolatedHost(root, {
      ...options,
      personas,
      handleForSession: (sessionID) =>
        directory.bySession(sessionID).pipe(
          Effect.map((conversation) => (conversation ? conversation.handle : undefined)),
          Effect.orDie,
        ),
      send: (sessionID, text, callID) =>
        Effect.gen(function* () {
          const conversation = yield* directory.bySession(sessionID);
          if (!conversation) return yield* Effect.fail(new Error("No Conversation for session"));
          return yield* sends.send(conversation, text, callID);
        }).pipe(Effect.mapError((error) => new Error(String(error)))),
      settledSends: (sessionID) => sends.results(sessionID),
    });
    const incoming = yield* intake(
      messages,
      (handle) => directory.byHandle(handle),
      (sessionID, id, text) =>
        host.sessions
          .prompt({ sessionID: Session.ID.make(sessionID), id: SessionMessage.ID.make(id), text })
          .pipe(Effect.asVoid),
      (personaID) => host.personas.get(personaID)!.timeZone,
      sends.reconcile,
    );
    return { ...host, conversations: directory, intake: incoming };
  });

/** Production opens the server's own file, never OpenCode's database. */
export const startMessagingServer = (
  root: string,
  options: Omit<HostOptions, "personas" | "send" | "handleForSession">,
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
