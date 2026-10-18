import { Effect } from "effect";
import type { Conversation, conversations } from "./conversations.ts";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import type { PersonaRuntime } from "../opencode/runtime.ts";
import type { Messages, IncomingMessage } from "@ren-ai/imsg";
import { intake } from "../intake/intake.ts";
import { rebuilder } from "./rebuild-session.ts";
import { resets } from "./reset.ts";

export const setupRebuilding = (
  directory: Effect.Success<typeof conversations>,
  host: PersonaRuntime,
  messages: Messages,
  reconcile: (conversation: Conversation, row: IncomingMessage) => Effect.Effect<boolean, Error>,
  received: (conversation: Conversation, date: number) => Effect.Effect<void, Error>,
  sent: (conversation: Conversation, date: number) => Effect.Effect<void, Error>,
  forget: (sessionID: string) => Effect.Effect<void>,
  arriving: (sessionID: string, messageID: string) => Effect.Effect<void, Error>,
  eager = true,
) =>
  Effect.gen(function* () {
    let restore: (handle: string) => Effect.Effect<void, Error>;
    const reset = yield* resets(directory, host, forget, messages);
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
      arriving,
    );
    const recovery = yield* rebuilder(directory, host, incoming.replay);
    restore = (handle) =>
      recovery.rebuild(handle).pipe(
        Effect.asVoid,
        Effect.mapError((error) => new Error(String(error))),
      );
    if (eager) {
      yield* incoming.resetPending;
      yield* recovery.missing;
    }
    yield* reset.resume;
    if (eager) yield* incoming.poll;
    return { incoming, recovery };
  });
