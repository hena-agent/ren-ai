import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import type { Persona } from "./personas/personas.ts";
import type { PersonaRuntime } from "./opencode/runtime.ts";
import { prepareMessaging, type MessagingTools } from "./application-tools.ts";
import type { Messages } from "./messages/messages.ts";
import type { Gestures } from "./gestures/gestures.ts";
import { onboarding } from "./onboarding/onboarding.ts";
import { followUps } from "./follow-ups/follow-ups.ts";
import { makeOperator } from "./operator/operator.ts";
import { failedTurns, type FailureAlerts } from "./opencode/failed-turns.ts";
import { setupRebuilding } from "./conversations/rebuild.ts";
import { retainedSessions } from "./conversations/retained.ts";

export interface OnboardingConfig {
  readonly turnstileSecret: string;
  readonly notice: Readonly<Record<"ko", string>>;
  readonly userCap?: number;
  readonly noticeVersion?: string;
}

export const startMessagingApplication = <Host extends PersonaRuntime, E, R>(
  personas: ReadonlyMap<string, Persona>,
  connect: (tools: MessagingTools) => Effect.Effect<Host, E, R>,
  messages: Messages,
  gestures: Gestures,
  onboardingConfig: OnboardingConfig,
  alerts: FailureAlerts,
) =>
  Effect.gen(function* () {
    const { tools, directory, pace, sends } = yield* prepareMessaging(personas, messages, gestures);
    const host = yield* connect(tools);
    const follow = yield* followUps(
      directory.active,
      (personaID) => host.personas.get(personaID)!.timeZone,
      (sessionID, id, text) =>
        directory.admit(
          sessionID,
          host.sessions
            .prompt({ sessionID: Session.ID.make(sessionID), id: SessionMessage.ID.make(id), text })
            .pipe(Effect.asVoid),
        ),
    );
    const retained = yield* retainedSessions(host);
    yield* retained.resume;
    sends.onSent(follow.sent);
    const forget = yield* failedTurns(host, directory, alerts);
    const { incoming, recovery } = yield* setupRebuilding(
      directory,
      host,
      messages,
      onboardingConfig.notice,
      sends.reconcile,
      follow.received,
      follow.sent,
      sends.notice,
      forget,
    );
    yield* Effect.forkScoped(follow.monitor);
    incoming.onNew((conversation) => pace.onNew(conversation.sessionID));
    const persona = host.personas.values().next().value!;
    const api = yield* onboarding({
      messages,
      notice: onboardingConfig.notice,
      persona,
      createSession: (id) => host.createSession(id),
      prompt: (sessionID, text) =>
        host.sessions
          .prompt({
            sessionID: Session.ID.make(sessionID),
            id: SessionMessage.ID.make(`msg_onboarding_${sessionID}`),
            text,
          })
          .pipe(Effect.asVoid),
      sendNotice: (handle, text) => sends.notice(handle, text),
      turnstileSecret: onboardingConfig.turnstileSecret,
      userCap: onboardingConfig.userCap,
      noticeVersion: onboardingConfig.noticeVersion,
    });
    yield* api.resume;
    const { handler: onboardingWeb, dispose: disposeOnboarding } = HttpRouter.toWebHandler(
      api.routes.pipe(Layer.provide(FetchHttpClient.layer)),
    );
    const operator = yield* makeOperator(
      directory,
      (sessionID) =>
        host.sessions
          .remove(Session.ID.make(sessionID))
          .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void)),
      (handle) => recovery.rebuild(handle, true),
      (sessionID, handle) =>
        retained.retainRemoved(sessionID, handle).pipe(Effect.tap(() => forget(sessionID))),
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
