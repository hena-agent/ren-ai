import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Conversation, conversations } from "./conversations.ts";
import { conversationStarted } from "../transcript/transcript.ts";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import type { PersonaRuntime } from "../opencode/runtime.ts";
import { withLifecycle } from "./lifecycle.ts";

interface Origin {
  readonly locale: "ko";
  readonly startedAt: number;
}

export const rebuilder = (
  directory: Effect.Success<typeof conversations>,
  host: PersonaRuntime,
  notice: Readonly<Record<"ko", string>>,
  replay: (conversation: Conversation) => Effect.Effect<void, Error>,
) => {
  const remove = (id: string) =>
    host.sessions
      .remove(Session.ID.make(id))
      .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void));
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rebuild = (handle: string, force = false) =>
      Effect.gen(function* () {
        const prepared = yield* directory.withHandle(handle)(
          withLifecycle(
            Effect.gen(function* () {
              let conversation = yield* directory.byHandle(handle);
              if (!conversation) return "not_found" as const;
              const oldID = conversation.sessionID;
              const missing = !(yield* host.sessions.get(Session.ID.make(oldID)).pipe(
                Effect.as(true),
                Effect.catchTag("Session.NotFoundError", () => Effect.succeed(false)),
              ));
              if (force || missing) {
                const session = yield* host.createSession(conversation.personaID);
                yield* directory.replaceSession(conversation, session.id);
                conversation = { ...conversation, sessionID: session.id };
              } else if (!(yield* directory.rebuilding(conversation))) {
                return "present" as const;
              }
              const [origin] =
                yield* sql<Origin>`SELECT user.locale, conversation.started_at AS startedAt
          FROM user JOIN conversation ON conversation.user_id = user.id
          WHERE conversation.id = ${conversation.id} AND conversation.session_id = ${conversation.sessionID}`;
              return {
                conversation,
                oldID,
                missing,
                origin,
                persona: host.personas.get(conversation.personaID),
              };
            }),
          ),
        );
        if (typeof prepared === "string") return prepared;
        const { conversation, oldID, missing, origin, persona } = prepared;
        if (!origin) {
          yield* remove(conversation.sessionID);
          return "not_found" as const;
        }
        if (!persona)
          return yield* Effect.fail(new Error(`Unknown persona: ${conversation.personaID}`));
        yield* host.sessions.prompt({
          sessionID: Session.ID.make(conversation.sessionID),
          id: SessionMessage.ID.make(`msg_onboarding_${conversation.sessionID}`),
          text: conversationStarted(
            origin.startedAt,
            persona.openingLine,
            notice[origin.locale],
            persona.timeZone,
          ),
        });
        yield* replay(conversation);
        yield* directory.rebuilt(conversation);
        if (oldID !== conversation.sessionID && !missing) yield* remove(oldID);
        return "rebuilt" as const;
      });
    const missing = Effect.gen(function* () {
      for (const conversation of yield* directory.all()) yield* rebuild(conversation.handle);
    });
    return { rebuild, missing };
  });
};
