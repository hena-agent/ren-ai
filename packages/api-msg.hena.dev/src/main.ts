import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { loadPersonas } from "./personas/personas.ts";
import { isolatedHost } from "./opencode/isolate.ts";
import type { HostOptions } from "./opencode/host.ts";
export { serveViewer, viewerFront } from "./opencode/viewer.ts";

export { makeHealth } from "./health/health.ts";
export { makeBackup } from "./backup/backup.ts";
export { onboardingApi, noticeCopy } from "./onboarding/onboarding.ts";
import { migrate } from "./database.ts";
import { conversations } from "./conversations/conversations.ts";
import { outbox } from "./outbox/outbox.ts";
import type { Messages } from "./messages/messages.ts";
import type { Gestures } from "./gestures/gestures.ts";
import { intake } from "./intake/intake.ts";
import { onboarding } from "./onboarding/onboarding.ts";
import { SqlClient } from "effect/unstable/sql";
import { notReacted } from "./transcript/transcript.ts";
import type { Tapback } from "./outbox/outbox.ts";

interface OnboardingConfig {
  readonly turnstileSecret: string;
  readonly notice: Readonly<Record<"ko", string>>;
}

export const startPersonaHost = (root: string, options: Omit<HostOptions, "personas">) =>
  Effect.flatMap(loadPersonas(options.personaDirectory), (personas) =>
    Effect.map(isolatedHost(root, { ...options, personas }), (host) => ({ ...host, personas })),
  );

export const startMessagingHost = (
  root: string,
  options: Omit<
    HostOptions,
    "personas" | "send" | "read" | "react" | "onContext" | "handleForSession"
  >,
  messages: Messages,
  gestures: Gestures,
  onboardingConfig: OnboardingConfig,
) =>
  Effect.gen(function* () {
    yield* migrate;
    const sql = yield* SqlClient.SqlClient;
    const directory = yield* conversations;
    const sends = yield* outbox(messages, gestures);
    const seenAtRequest = new Map<string, string | undefined>();
    const host = yield* startPersonaHost(root, {
      ...options,
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
    const persona = host.personas.values().next().value!;
    const api = yield* onboarding(
      messages,
      onboardingConfig.notice,
      persona,
      (id) => host.createSession(id),
      (sessionID, text) =>
        host.sessions
          .prompt({
            sessionID: Session.ID.make(sessionID),
            id: SessionMessage.ID.make(`msg_onboarding_${sessionID}`),
            text,
          })
          .pipe(Effect.asVoid),
      (handle, text) => sends.notice(handle, text),
      onboardingConfig.turnstileSecret,
    );
    yield* api.resume;
    const { handler: onboardingWeb, dispose: disposeOnboarding } = HttpRouter.toWebHandler(
      api.routes.pipe(Layer.provide(FetchHttpClient.layer)),
    );
    return {
      ...host,
      conversations: directory,
      intake: incoming,
      onboard: api.submit,
      onboardingWeb,
      disposeOnboarding,
    };
  });

/** Production opens the server's own file, never OpenCode's database. */
export const startMessagingServer = (
  root: string,
  options: Omit<
    HostOptions,
    "personas" | "send" | "read" | "react" | "onContext" | "handleForSession"
  >,
  databaseFile: string,
  messages: Messages,
  gestures: Gestures,
  onboardingConfig: OnboardingConfig,
) =>
  Effect.gen(function* () {
    const { SqliteClient } = yield* Effect.promise(() => import("@effect/sql-sqlite-bun"));
    const database = yield* Layer.build(
      SqliteClient.layer({ filename: databaseFile, busyTimeout: "5 seconds" }),
    );
    return yield* startMessagingHost(root, options, messages, gestures, onboardingConfig).pipe(
      Effect.provide(database),
    );
  });
