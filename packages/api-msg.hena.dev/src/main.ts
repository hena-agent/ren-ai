import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { loadPersonas } from "./personas/personas.ts";
import { isolatedHost } from "./opencode/isolate.ts";
import type { HostOptions, PersonaHostOptions } from "./opencode/host.ts";
export { serveViewer, viewerFront } from "./opencode/viewer.ts";

export { makeHealth } from "./health/health.ts";
export { makeMessagesUi } from "./gestures/messages-ui.ts";
export { makeBackup } from "./backup/backup.ts";
export { onboardingApi, noticeCopy } from "./onboarding/onboarding.ts";
import { migrate } from "./database.ts";
import { conversations } from "./conversations/conversations.ts";
import type { Conversation } from "./conversations/conversations.ts";
import { outbox } from "./outbox/outbox.ts";
import type { Messages } from "./messages/messages.ts";
import type { Gestures } from "./gestures/gestures.ts";
import { intake } from "./intake/intake.ts";
import { onboarding } from "./onboarding/onboarding.ts";
import { SqlClient } from "effect/unstable/sql";
import { notReacted } from "./transcript/transcript.ts";
import type { Tapback } from "./outbox/outbox.ts";
import { timing } from "./timing/timing.ts";
import { followUps } from "./follow-ups/follow-ups.ts";
import { makeOperator } from "./operator/operator.ts";
export { operatorHandler, operatorApi } from "./operator/api.ts";
export { serveOperatorSocket, operatorClient } from "./operator/socket.ts";
export { runOperatorCli } from "./operator/cli.ts";

interface OnboardingConfig {
  readonly turnstileSecret: string;
  readonly notice: Readonly<Record<"ko", string>>;
  readonly userCap?: number;
}

export const startPersonaHost = (root: string, options: PersonaHostOptions) =>
  Effect.flatMap(loadPersonas(options.personaDirectory), (personas) =>
    Effect.map(isolatedHost(root, { ...options, personas }), (host) => ({ ...host, personas })),
  );

export const startMessagingHost = (
  root: string,
  options: Omit<
    HostOptions,
    "personas" | "send" | "wait" | "read" | "react" | "onContext" | "handleForSession"
  >,
  messages: Messages,
  gestures: Gestures,
  onboardingConfig: OnboardingConfig,
) =>
  Effect.gen(function* () {
    yield* migrate;
    const sql = yield* SqlClient.SqlClient;
    const directory = yield* conversations;
    const pace = timing();
    const personas = yield* loadPersonas(options.personaDirectory);
    const sends = yield* outbox(messages, gestures, personas, directory.active, pace);
    const seenAtRequest = new Map<string, string | undefined>();
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
    const host = yield* isolatedHost(root, {
      ...options,
      personas,
      handleForSession: (sessionID) =>
        directory.bySession(sessionID).pipe(
          Effect.map((conversation) => (conversation ? conversation.handle : undefined)),
          Effect.orDie,
        ),
      send: (sessionID, text, callID) =>
        inConversation(sessionID, (conversation) => sends.send(conversation, text, callID)),
      wait: (sessionID, minutes) =>
        inConversation(sessionID, (conversation) => pace.wait(conversation.id, minutes)),
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
      lastMessageStatus: (sessionID) =>
        directory
          .bySession(sessionID)
          .pipe(
            Effect.flatMap((conversation) =>
              conversation
                ? messages.lastOutgoingStatus(conversation.handle)
                : Effect.succeed(undefined),
            ),
          ),
      settledSends: (sessionID) => sends.results(sessionID),
    });
    const follow = yield* followUps(
      directory.active,
      (personaID) => host.personas.get(personaID)!.timeZone,
      (sessionID, id, text) =>
        host.sessions
          .prompt({ sessionID: Session.ID.make(sessionID), id: SessionMessage.ID.make(id), text })
          .pipe(Effect.asVoid),
    );
    sends.onSent(follow.sent);
    const incoming = yield* intake(
      messages,
      (handle) => directory.byHandle(handle),
      (sessionID, id, text) =>
        host.sessions
          .prompt({ sessionID: Session.ID.make(sessionID), id: SessionMessage.ID.make(id), text })
          .pipe(Effect.asVoid),
      (personaID) => host.personas.get(personaID)!.timeZone,
      sends.reconcile,
      follow.received,
    );
    yield* Effect.forkScoped(follow.monitor);
    incoming.onNew((conversation) => pace.onNew(conversation.id));
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
      10_000,
      onboardingConfig.userCap,
    );
    yield* api.resume;
    const { handler: onboardingWeb, dispose: disposeOnboarding } = HttpRouter.toWebHandler(
      api.routes.pipe(Layer.provide(FetchHttpClient.layer)),
    );
    const operator = yield* makeOperator(directory, (sessionID) =>
      host.sessions
        .remove(Session.ID.make(sessionID))
        .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void)),
    );
    return {
      ...host,
      conversations: directory,
      intake: incoming,
      operator,
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
    "personas" | "send" | "wait" | "read" | "react" | "onContext" | "handleForSession"
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
