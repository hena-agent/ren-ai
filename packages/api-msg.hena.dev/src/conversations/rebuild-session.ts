import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Conversation, conversations } from "./conversations.ts";
import { conversationStarted } from "../transcript/transcript.ts";
import type { Persona } from "../personas/personas.ts";

interface Origin {
  readonly locale: "ko";
  readonly joinedAt: number;
}

type Directory = Omit<Effect.Success<typeof conversations>, "replaceSession"> & {
  readonly replaceSession: (
    conversation: Conversation,
    sessionID: string,
  ) => Effect.Effect<ReadonlyArray<object>, Error>;
};

export const rebuilder = <CreateError, SessionError, PromptError, ReplayError>(
  directory: Directory,
  personas: ReadonlyMap<string, Persona>,
  notice: Readonly<Record<"ko", string>>,
  create: (personaID: string) => Effect.Effect<{ readonly id: string }, CreateError>,
  exists: (sessionID: string) => Effect.Effect<boolean, SessionError>,
  remove: (sessionID: string) => Effect.Effect<void, SessionError>,
  prompt: (sessionID: string, id: string, text: string) => Effect.Effect<void, PromptError>,
  replay: (conversation: Conversation) => Effect.Effect<void, ReplayError>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rebuild = (handle: string, force = false) =>
      Effect.gen(function* () {
        let conversation = yield* directory.byHandle(handle);
        if (!conversation) return "not_found" as const;
        const oldID = conversation.sessionID;
        const missing = !(yield* exists(oldID));
        if (force || missing) {
          const session = yield* create(conversation.personaID);
          yield* directory.replaceSession(conversation, session.id);
          conversation = { ...conversation, sessionID: session.id };
        } else if (!(yield* directory.rebuilding(conversation))) {
          return "present" as const;
        }
        const [origin] = yield* sql<Origin>`SELECT user.locale, user.joined_at AS joinedAt
          FROM user JOIN conversation ON conversation.user_id = user.id
          WHERE conversation.id = ${conversation.id} AND conversation.session_id = ${conversation.sessionID}`;
        if (!origin) {
          yield* remove(conversation.sessionID);
          return "not_found" as const;
        }
        const persona = personas.get(conversation.personaID);
        if (!persona)
          return yield* Effect.fail(new Error(`Unknown persona: ${conversation.personaID}`));
        yield* prompt(
          conversation.sessionID,
          `msg_onboarding_${conversation.sessionID}`,
          conversationStarted(
            origin.joinedAt,
            persona.openingLine,
            notice[origin.locale],
            persona.timeZone,
          ),
        );
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
