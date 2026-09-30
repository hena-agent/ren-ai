import { OpenCode } from "@opencode/client/effect";
import type {
  MessageListInput,
  SessionPromptInput,
  SessionUpdateInput,
  SessionInboxCancelInput,
} from "@opencode/client/effect/api";
import { AbsolutePath, Agent, Model, Session } from "@opencode/schema";
import { SessionMessage } from "@opencode/schema/session-message";
import { Effect, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { Persona } from "../personas/personas.ts";
import { MissingSession, type PersonaRuntime } from "./runtime.ts";

const remoteError = (error: Error & { readonly _tag: string }): Error | MissingSession =>
  error["_tag"] === "SessionNotFoundError"
    ? new MissingSession({ message: error.message })
    : new Error(error.message);

export interface RemoteConfig {
  readonly baseUrl: string;
  readonly authorization: string;
  readonly directory: string;
  readonly model: string;
}

export const remoteHost = (config: RemoteConfig, personas: ReadonlyMap<string, Persona>) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const client = yield* OpenCode.make({ baseUrl: config.baseUrl }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        http.pipe(
          HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", config.authorization)),
        ),
      ),
    );
    const sessions = {
      get: (sessionID: Session.ID) =>
        client.session.get({ sessionID }).pipe(Effect.mapError(remoteError)),
      prompt: (input: SessionPromptInput) =>
        client.session.prompt(input).pipe(Effect.mapError(remoteError)),
      wait: (sessionID: Session.ID) =>
        client.session.wait({ sessionID }).pipe(Effect.mapError(remoteError)),
      messages: (input: MessageListInput) =>
        client.message.list(input).pipe(
          Effect.map((page) => page.data),
          Effect.mapError(remoteError),
        ),
      rename: (input: SessionUpdateInput) =>
        client.session.update(input).pipe(Effect.mapError(remoteError)),
      interrupt: (sessionID: Session.ID) =>
        client.session.interrupt({ sessionID }).pipe(
          Effect.map((result) => result.interrupted),
          Effect.mapError(remoteError),
        ),
      remove: (sessionID: Session.ID) =>
        client.session.remove({ sessionID }).pipe(Effect.mapError(remoteError)),
      inbox: (sessionID: Session.ID) =>
        client.session.inbox.list({ sessionID }).pipe(Effect.mapError(remoteError)),
      cancelInbox: (input: SessionInboxCancelInput) =>
        client.session.inbox.cancel(input).pipe(Effect.mapError(remoteError)),
    };
    const host = {
      client,
      personas,
      sessions,
      outcomes: client.event.subscribe().pipe(
        Stream.filter(
          (event) =>
            event.type === "server.connected" ||
            event.type === "session.execution.failed" ||
            event.type === "session.execution.succeeded",
        ),
        Stream.mapError(() => new Error("OpenCode event stream disconnected")),
      ),
      retry: (sessionID: Session.ID) =>
        Effect.gen(function* () {
          const session = yield* sessions.get(sessionID);
          const pending = yield* sessions.inbox(sessionID);
          if (pending.length) {
            yield* client.session
              .synthetic({
                sessionID,
                id: SessionMessage.ID.make(`msg_resume_${pending[0]!.id}`),
                text: "Continue the pending Conversation work without repeating completed sends or reactions.",
                delivery: "queue",
              })
              .pipe(Effect.mapError(remoteError));
            return;
          }
          if (session.outcome === "succeeded") return;
          const [latest] = yield* sessions.messages({ sessionID, type: "assistant", limit: 1 });
          if (session.outcome !== "failed" && !(latest?.type === "assistant" && latest.error))
            return;
          yield* client.session
            .synthetic({
              sessionID,
              id: SessionMessage.ID.make(`msg_retry_${latest?.id ?? sessionID}`),
              text: "Continue the interrupted Conversation. Check the recorded tool results and do not repeat completed sends or reactions.",
              delivery: "queue",
            })
            .pipe(Effect.mapError(remoteError));
        }),
      createSession: (personaID: string) =>
        Effect.gen(function* () {
          if (!personas.has(personaID))
            return yield* Effect.fail(new Error(`Unknown persona: ${personaID}`));
          return yield* client.session
            .create({
              agent: Agent.ID.make(personaID),
              model: Model.Ref.parse(config.model),
              location: { directory: AbsolutePath.make(config.directory) },
              permissions: [
                { action: "*", resource: "*", effect: "deny" },
                ...["send", "read", "react", "wait"].map((action) => ({
                  action,
                  resource: "*",
                  effect: "allow" as const,
                })),
              ],
            })
            .pipe(Effect.mapError(remoteError));
        }),
    };
    return host satisfies PersonaRuntime;
  });
