import { OpenCode } from "@opencode/client/effect";
import { createHash } from "node:crypto";
import type {
  MessageListInput,
  SessionPromptInput,
  SessionUpdateInput,
  SessionInboxCancelInput,
} from "@opencode/client/effect/api";
import { Session } from "@opencode/schema";
import { SessionMessage } from "@opencode/schema/session-message";
import { Effect, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import type { Persona } from "@ren-ai/personas";
import { MissingSession, type PersonaRuntime } from "./runtime.ts";

const recoveryID = (key: string) =>
  SessionMessage.ID.make(`msg_${createHash("sha256").update(key).digest("hex")}`);

const remoteError = (error: Error & { readonly _tag: string }): Error | MissingSession =>
  error["_tag"] === "SessionNotFoundError"
    ? new MissingSession({ message: error.message })
    : new Error(error.message);

export interface RemoteConfig {
  readonly baseUrl: string;
  readonly authorization: string;
  readonly directory: string;
  readonly model: string;
  readonly groundRules: string;
  readonly onPrompt?: (sessionID: string) => Effect.Effect<void, Error>;
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
    const folders = client.rpc(sessionFolders);
    const location = { location: { directory: config.directory } };
    const sessions = {
      get: (sessionID: Session.ID) =>
        client.session.get({ sessionID }).pipe(Effect.mapError(remoteError)),
      prompt: (input: SessionPromptInput) =>
        (config.onPrompt?.(input.sessionID) ?? Effect.void).pipe(
          Effect.andThen(client.session.prompt(input)),
          Effect.mapError((error) => ("_tag" in error ? remoteError(error) : error)),
        ),
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
        client.session.remove({ sessionID }).pipe(
          Effect.catchTag("SessionNotFoundError", () => Effect.void),
          Effect.andThen(folders.remove({ folderID: sessionID }, location)),
          Effect.asVoid,
          Effect.mapError((error) => new Error(JSON.stringify(error))),
        ),
      writable: (sessionID: Session.ID, writable: boolean) =>
        client.session
          .get({ sessionID })
          .pipe(
            Effect.mapError(remoteError),
            Effect.andThen(
              folders
                .writable({ folderID: sessionID, writable }, location)
                .pipe(Effect.mapError((error) => new Error(error.message))),
            ),
            Effect.asVoid,
          ),
      removeRelationship: (personaID: string, conversationKey: string) =>
        folders.removeRelationship({ personaID, conversationKey }, location).pipe(
          Effect.asVoid,
          Effect.mapError((error) => new Error(error.message)),
        ),
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
          yield* config.onPrompt?.(sessionID) ?? Effect.void;
          const session = yield* sessions.get(sessionID);
          const pending = yield* sessions.inbox(sessionID);
          if (pending.length) {
            yield* client.session
              .synthetic({
                sessionID,
                id: recoveryID(pending[0]!.id),
                text: "Continue the pending Conversation work without repeating completed sends or reactions.",
                delivery: "queue",
              })
              .pipe(Effect.mapError(remoteError));
            return;
          }
          if (session.outcome === "succeeded") return;
          const history = yield* sessions.messages({ sessionID, order: "desc" });
          const latest = history.find((message) => message.type === "assistant");
          if (session.outcome !== "failed" && !latest?.error) return;
          // A context failure may create a new terminal checkpoint without a
          // new assistant. Keep its key stable while retry preparation runs.
          const checkpoint = history.find((message) => message.type === "idle");
          yield* client.session
            .synthetic({
              sessionID,
              id: recoveryID(checkpoint?.id ?? latest?.id ?? sessionID),
              text: "Continue the interrupted Conversation. Check the recorded tool results and do not repeat completed sends or reactions. Keep completed memory updates and reuse existing dice decisions.",
              delivery: "queue",
            })
            .pipe(Effect.mapError(remoteError));
        }),
      createSession: (
        personaID: string,
        sessionID?: Session.ID,
        conversationKey?: string,
        writable?: boolean,
      ) =>
        Effect.gen(function* () {
          if (!personas.has(personaID))
            return yield* Effect.fail(new Error(`Unknown persona: ${personaID}`));
          const id = sessionID ?? Session.ID.create();
          yield* folders
            .create(
              {
                folderID: id,
                snapshot: renderSnapshot(personas.get(personaID)!, config.groundRules),
                model: config.model,
                conversationKey: conversationKey ?? id,
                ...(writable !== undefined && { writable }),
              },
              location,
            )
            .pipe(Effect.mapError((error) => new Error(error.message)));
          return yield* sessions.get(id);
        }),
    };
    return host satisfies PersonaRuntime;
  });
