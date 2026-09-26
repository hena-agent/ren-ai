import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";
import { Session } from "@opencode/core/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { loadPersonas } from "./personas/personas.ts";
import { isolatedHost } from "./opencode/isolate.ts";
import type { HostOptions } from "./opencode/host.ts";
export { serveViewer, viewerFront } from "./opencode/viewer.ts";

export { makeHealth } from "./health/health.ts";
export { onboardingApi, noticeCopy } from "./onboarding/onboarding.ts";
import { migrate } from "./database.ts";
import { conversations } from "./conversations/conversations.ts";
import { outbox } from "./outbox/outbox.ts";
import type { Messages } from "./messages/messages.ts";
import type { Gestures } from "./gestures/gestures.ts";
import { onboarding } from "./onboarding/onboarding.ts";

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
  options: Omit<HostOptions, "personas" | "send" | "handleForSession">,
  messages: Messages,
  gestures: Gestures,
  onboardingConfig: OnboardingConfig,
) =>
  Effect.gen(function* () {
    yield* migrate;
    const directory = yield* conversations;
    const sends = yield* outbox(messages, gestures);
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
    });
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
      onboard: api.submit,
      onboardingWeb,
      disposeOnboarding,
    };
  });

/** Production opens the server's own file, never OpenCode's database. */
export const startMessagingServer = (
  root: string,
  options: Omit<HostOptions, "personas" | "send" | "handleForSession">,
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
