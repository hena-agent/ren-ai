import { Effect } from "effect";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import type { Persona } from "@ren-ai/personas";
import type { PersonaRuntime } from "./opencode/runtime.ts";
import { prepareMessaging, type MessagingTools } from "./application-tools.ts";
import type { Messages, Gestures } from "@ren-ai/imsg";
import { followUps } from "./follow-ups/follow-ups.ts";
import { makeOperator } from "./operator/operator.ts";
import { failedTurns, type FailureAlerts } from "./opencode/failed-turns.ts";
import { setupRebuilding } from "./conversations/rebuild.ts";
import { retainedSessions } from "./conversations/retained.ts";
import { stoppedConversations } from "./conversations/stop.ts";

export const startMessagingApplication = <Host extends PersonaRuntime, E, R>(
  personas: ReadonlyMap<string, Persona>,
  connect: (tools: MessagingTools) => Effect.Effect<Host, E, R>,
  messages: Messages,
  gestures: Gestures,
  alerts: FailureAlerts,
) =>
  Effect.gen(function* () {
    const { tools, directory, pace, sends, endings } = yield* prepareMessaging(
      personas,
      messages,
      gestures,
    );
    const host = yield* connect(tools);
    const stopped = yield* stoppedConversations(host);
    yield* stopped.resume;
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
    const failed = yield* failedTurns(host, directory, alerts);
    const { incoming, recovery } = yield* setupRebuilding(
      directory,
      host,
      messages,
      sends.reconcile,
      follow.received,
      follow.sent,
      failed.forget,
      pace.onNew,
    );
    const operator = yield* makeOperator(
      directory,
      (sessionID) =>
        host.sessions
          .remove(Session.ID.make(sessionID))
          .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void)),
      (handle) => recovery.rebuild(handle, true),
      (sessionID, handle) =>
        retained.retainRemoved(sessionID, handle).pipe(Effect.tap(() => failed.forget(sessionID))),
    );
    return {
      ...host,
      conversations: directory,
      intake: incoming,
      operator,
      endingOperations: endings,
      heartbeat: {
        intake: incoming.poll,
        followUps: follow.tick,
        failedTurns: failed.tick,
        endings: endings.tick,
        stopped: stopped.tick,
      },
    };
  });
