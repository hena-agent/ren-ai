import { Session } from "@opencode/schema/session";
import type { SessionEvent } from "@opencode/schema/session-event";
import type { SessionMessage } from "@opencode/schema/session-message";
import type { SessionInbox } from "@opencode/schema/session-inbox";
import type { SessionPromptInput } from "@opencode/client/effect/api";
import { Data, type Effect, type Stream } from "effect";
import type { Persona } from "../personas/personas.ts";

export class MissingSession extends Data.TaggedError("Session.NotFoundError")<{
  readonly message: string;
}> {}
type RuntimeError = Error | MissingSession;

export interface PersonaRuntime {
  readonly personas: ReadonlyMap<string, Persona>;
  readonly createSession: (personaID: string) => Effect.Effect<Session.Info, RuntimeError>;
  readonly outcomes: Stream.Stream<
    | SessionEvent.Execution.Failed
    | SessionEvent.Execution.Succeeded
    | { readonly type: "server.connected" },
    Error
  >;
  readonly retry: (sessionID: Session.ID) => Effect.Effect<void, RuntimeError>;
  readonly sessions: {
    readonly get: (id: Session.ID) => Effect.Effect<Session.Info, RuntimeError>;
    readonly prompt: (
      input: Pick<SessionPromptInput, "sessionID" | "text" | "files"> & {
        readonly id?: SessionMessage.ID;
        readonly resume?: boolean;
      },
    ) => Effect.Effect<SessionInbox.User, RuntimeError>;
    readonly messages: (input: {
      readonly sessionID: Session.ID;
      readonly type?: "assistant";
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<SessionMessage.Info>, RuntimeError>;
    readonly interrupt: (id: Session.ID) => Effect.Effect<boolean, RuntimeError>;
    readonly wait: (id: Session.ID) => Effect.Effect<void, RuntimeError>;
    readonly remove: (id: Session.ID) => Effect.Effect<void, RuntimeError>;
    readonly inbox: (
      id: Session.ID,
    ) => Effect.Effect<ReadonlyArray<SessionInbox.Info>, RuntimeError>;
    readonly cancelInbox: (input: {
      readonly sessionID: Session.ID;
      readonly inboxID: SessionMessage.ID;
    }) => Effect.Effect<void, RuntimeError>;
    readonly rename: (input: {
      readonly sessionID: Session.ID;
      readonly title: string;
    }) => Effect.Effect<void, RuntimeError>;
  };
}
