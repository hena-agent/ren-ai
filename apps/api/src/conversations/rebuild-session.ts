import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Conversation, conversations } from "./conversations.ts";
import { conversationStarted } from "../transcript/transcript.ts";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import type { PersonaRuntime } from "../opencode/runtime.ts";
import { withLifecycle } from "./lifecycle.ts";
import { claimWork, workBatchSize } from "../work-budget.ts";
import type { StartingRelationship } from "@ren-ai/onboarding";

interface Origin {
  readonly startedAt: number;
  readonly conversationLanguage: string | null;
  readonly startingRelationship: StartingRelationship | null;
  readonly name: string | null;
  readonly age: number | null;
  readonly gender: string | null;
}

export const rebuilder = (
  directory: Effect.Success<typeof conversations>,
  host: PersonaRuntime,
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
              const [origin] = yield* sql<Origin>`SELECT conversation.started_at AS startedAt,
                l.conversation_language AS conversationLanguage, p.name, p.age, p.gender,
                conversation.starting_relationship AS startingRelationship
          FROM user JOIN conversation ON conversation.user_id = user.id
          LEFT JOIN discovery_registration r ON r.id = conversation.registration_id
          LEFT JOIN discovery_language l ON l.registration_id = r.id
          LEFT JOIN discovery_profile p ON p.registration_id = r.id
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
          id: SessionMessage.ID.make(`msg_started_${conversation.sessionID}`),
          text: conversationStarted(
            origin.startedAt,
            persona.openingLine,
            persona.timeZone,
            origin.conversationLanguage ?? undefined,
            origin,
            origin.startingRelationship ?? undefined,
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
    const pending = Effect.gen(function* () {
      const limit = Math.min(20, yield* workBatchSize);
      const [cursor] = yield* sql<{
        at: number;
      }>`SELECT at FROM application_clock WHERE name = 'rebuild.cursor'`;
      const select = (after: number) => sql<{
        id: number;
        handle: string;
      }>`SELECT c.id, u.handle FROM conversation c JOIN user u ON u.id = c.user_id
         WHERE c.id > ${after} AND c.rebuilding = 1 AND c.ended_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM blocked WHERE handle = u.handle)
        AND NOT EXISTS (SELECT 1 FROM removal WHERE handle = u.handle)
         ORDER BY c.id LIMIT ${limit}`;
      const after = yield* select(cursor?.at ?? 0);
      const rows = after.length ? after : yield* select(0);
      for (const row of rows) {
        if (!(yield* claimWork)) break;
        yield* sql`INSERT INTO application_clock(name, at) VALUES ('rebuild.cursor', ${row.id}) ON CONFLICT(name) DO UPDATE SET at = excluded.at`;
        yield* rebuild(row.handle);
      }
    });
    return {
      rebuild,
      missing,
      pending: pending.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    };
  });
};
