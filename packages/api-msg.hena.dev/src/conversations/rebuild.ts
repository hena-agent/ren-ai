import { Effect } from "effect";
import type { Conversation, conversations } from "./conversations.ts";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import type { isolatedHost } from "../opencode/isolate.ts";
import type { Messages, IncomingMessage } from "../messages/messages.ts";
import { intake } from "../intake/intake.ts";
import { rebuilder } from "./rebuild-session.ts";

export const setupRebuilding = (
  directory: Effect.Success<typeof conversations>,
  host: Effect.Success<ReturnType<typeof isolatedHost>>,
  messages: Messages,
  notice: Readonly<Record<"ko", string>>,
  reconcile: (conversation: Conversation, row: IncomingMessage) => Effect.Effect<boolean, Error>,
  received: (conversation: Conversation, date: number) => Effect.Effect<void, Error>,
  sent: (conversation: Conversation, date: number) => Effect.Effect<void, Error>,
) =>
  Effect.gen(function* () {
    let restore: (handle: string) => Effect.Effect<void, Error>;
    const incoming = yield* intake(
      messages,
      directory.byHandle,
      (sessionID, id, text, files) =>
        host.sessions
          .prompt({
            sessionID: Session.ID.make(sessionID),
            id: SessionMessage.ID.make(id),
            text,
            files,
          })
          .pipe(Effect.asVoid),
      (personaID) => host.personas.get(personaID)!.timeZone,
      reconcile,
      received,
      (handle) => restore(handle),
      false,
      sent,
    );
    const recovery = yield* rebuilder(
      directory,
      host.personas,
      notice,
      host.createSession,
      (id) =>
        host.sessions.get(Session.ID.make(id)).pipe(
          Effect.as(true),
          Effect.catchTag("Session.NotFoundError", () => Effect.succeed(false)),
        ),
      (id) =>
        host.sessions
          .remove(Session.ID.make(id))
          .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void)),
      (id, messageID, text) =>
        host.sessions
          .prompt({
            sessionID: Session.ID.make(id),
            id: SessionMessage.ID.make(messageID),
            text,
          })
          .pipe(Effect.asVoid),
      incoming.replay,
    );
    restore = (handle) =>
      recovery.rebuild(handle).pipe(
        Effect.asVoid,
        Effect.mapError((error) => new Error(String(error))),
      );
    yield* recovery.missing;
    yield* incoming.start;
    return { incoming, recovery };
  });
