import { Effect } from "effect";
import type { Conversation, conversations } from "./conversations.ts";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import type { isolatedHost } from "../opencode/isolate.ts";
import type { Messages, IncomingMessage } from "../messages/messages.ts";
import { intake } from "../intake/intake.ts";
import { rebuilder } from "./rebuild-session.ts";
import { resets } from "./reset.ts";

export const setupRebuilding = (
  directory: Effect.Success<typeof conversations>,
  host: Effect.Success<ReturnType<typeof isolatedHost>>,
  messages: Messages,
  notice: Readonly<Record<"ko", string>>,
  reconcile: (conversation: Conversation, row: IncomingMessage) => Effect.Effect<boolean, Error>,
  received: (conversation: Conversation, date: number) => Effect.Effect<void, Error>,
  sent: (conversation: Conversation, date: number) => Effect.Effect<void, Error>,
  sendNotice: (handle: string, text: string) => Effect.Effect<void, Error>,
  forget: (sessionID: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    let restore: (handle: string) => Effect.Effect<void, Error>;
    const reset = yield* resets(directory, host, notice, sendNotice, forget, messages);
    const incoming = yield* intake(
      messages,
      directory.byHandle,
      (sessionID, id, text, files) =>
        directory.admit(
          sessionID,
          host.sessions.prompt({
            sessionID: Session.ID.make(sessionID),
            id: SessionMessage.ID.make(id),
            text,
            files,
          }),
        ),
      (personaID) => host.personas.get(personaID)!.timeZone,
      reconcile,
      received,
      (handle) => restore(handle),
      false,
      sent,
      reset.receive,
    );
    const recovery = yield* rebuilder(directory, host, notice, incoming.replay);
    restore = (handle) =>
      recovery.rebuild(handle).pipe(
        Effect.asVoid,
        Effect.mapError((error) => new Error(String(error))),
      );
    yield* incoming.resetPending;
    yield* recovery.missing;
    yield* reset.resume;
    yield* incoming.start;
    return { incoming, recovery };
  });
