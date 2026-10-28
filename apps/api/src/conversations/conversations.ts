import { Clock, Effect, PartitionedSemaphore, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { bindUsageSessions } from "../usage/schema.ts";
import { claimPersona } from "../discovery/assignment.ts";

export interface Conversation {
  readonly id: number;
  readonly handle: string;
  readonly personaID: string;
  readonly sessionID: string;
}

export const conversations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const locks = yield* PartitionedSemaphore.make<string>({ permits: 1 });
  const replayLocks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
  const withHandle = (handle: string) => PartitionedSemaphore.withPermit(locks, handle);
  const lookup = (column: "handle" | "session_id", value: string) =>
    Effect.map(
      sql<Conversation>`SELECT conversation.id, user.handle, conversation.persona_id AS personaID,
        conversation.session_id AS sessionID FROM conversation
        JOIN user ON user.id = conversation.user_id
        WHERE ${sql(column)} = ${value}
          AND conversation.ended_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM blocked WHERE blocked.handle = user.handle)`,
      (rows) => rows[0],
    );
  return {
    withHandle,
    // Recovery callers join one replay; a forced replacement has its own fence and lock.
    withReplay:
      (sessionID: string) =>
      <A, E, R>(action: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const lock = replayLocks.get(sessionID) ?? {
              semaphore: Semaphore.makeUnsafe(1),
              users: 0,
            };
            lock.users++;
            replayLocks.set(sessionID, lock);
            return lock;
          }),
          (lock) => lock.semaphore.withPermit(action),
          (lock) =>
            Effect.sync(() => {
              if (--lock.users === 0) replayLocks.delete(sessionID);
            }),
        ),
    admitLive: (conversation: Conversation, action: Effect.Effect<void, Error>) =>
      withHandle(conversation.handle)(
        Effect.gen(function* () {
          const [current] = yield* sql`SELECT 1 FROM conversation WHERE id = ${conversation.id}
          AND session_id = ${conversation.sessionID} AND rebuilding = 0 AND ended_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM blocked WHERE handle = ${conversation.handle})`;
          if (!current)
            return yield* Effect.fail(
              new Error("Conversation changed or is still rebuilding; retry live admission"),
            );
          return yield* action;
        }),
      ),
    admit: <A, E, R>(sessionID: string, action: Effect.Effect<A, E, R>, replay = false) =>
      Effect.gen(function* () {
        const conversation = yield* lookup("session_id", sessionID);
        if (!conversation) return;
        yield* withHandle(conversation.handle)(
          Effect.gen(function* () {
            if (!(yield* lookup("session_id", sessionID))) return;
            const ready =
              replay ||
              (yield* sql`SELECT 1 FROM conversation WHERE session_id = ${sessionID} AND rebuilding = 0`)
                .length > 0;
            if (ready) yield* action;
          }),
        );
      }),
    byHandle: (handle: string) => lookup("handle", handle),
    bySession: (sessionID: string) => lookup("session_id", sessionID),
    all: () => sql<Conversation>`SELECT conversation.id, user.handle, conversation.persona_id AS personaID,
      conversation.session_id AS sessionID FROM conversation
      JOIN user ON user.id = conversation.user_id
        WHERE conversation.ended_at IS NULL AND NOT EXISTS (SELECT 1 FROM blocked WHERE blocked.handle = user.handle)`,
    replaceSession: (conversation: Conversation, sessionID: string) =>
      Effect.gen(function* () {
        yield* bindUsageSessions(sql);
        const rows = yield* sql`UPDATE conversation SET session_id = ${sessionID}, rebuilding = 1,
            replay_source_session_id = CASE WHEN rebuilding = 1 THEN COALESCE(replay_source_session_id, session_id) ELSE session_id END
            WHERE id = ${conversation.id}
        AND session_id = ${conversation.sessionID} AND ended_at IS NULL AND NOT EXISTS
        (SELECT 1 FROM blocked WHERE blocked.handle = ${conversation.handle}) RETURNING id`;
        yield* bindUsageSessions(sql);
        return rows;
      }).pipe(sql.withTransaction),
    rebuilt: (conversation: Conversation) =>
      sql`UPDATE conversation SET rebuilding = 0, replay_source_session_id = NULL WHERE id = ${conversation.id} AND session_id = ${conversation.sessionID}`,
    rebuilding: (conversation: Conversation) =>
      Effect.map(
        sql<{
          rebuilding: number;
        }>`SELECT rebuilding FROM conversation WHERE id = ${conversation.id}
        AND session_id = ${conversation.sessionID}`,
        (rows) => rows[0]?.rebuilding === 1,
      ),
    block: (handle: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT OR IGNORE INTO blocked (handle, blocked_at) VALUES (${handle}, ${now})`;
      }),
    active: (conversation: Conversation) =>
      Effect.map(
        sql`SELECT 1 FROM conversation JOIN user ON user.id = conversation.user_id
          WHERE conversation.id = ${conversation.id} AND user.handle = ${conversation.handle}
          AND conversation.session_id = ${conversation.sessionID}
          AND conversation.rebuilding = 0
          AND conversation.ended_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM blocked WHERE blocked.handle = user.handle)`,
        (rows) => rows.length > 0,
      ),
    create: (input: {
      handle: string;
      locale: string;
      consentVersion: string;
      consentLanguage: string;
      personaID: string;
      sessionID: string;
      conversationKey?: string;
    }) =>
      Effect.gen(function* () {
        if (
          !(yield* claimPersona(input.personaID, input.handle).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          ))
        )
          return yield* Effect.fail(new Error("Persona assignment is unavailable"));
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at, joined_at)
          VALUES (${input.handle}, ${input.locale}, ${input.consentVersion}, ${input.consentLanguage}, ${now}, ${now})`;
        yield* sql`INSERT INTO conversation (user_id, persona_id, session_id, started_at, usage_key)
          VALUES ((SELECT id FROM user WHERE handle = ${input.handle}), ${input.personaID}, ${input.sessionID}, ${now}, ${input.conversationKey ?? input.sessionID})`;
        yield* bindUsageSessions(sql);
        return (yield* lookup("session_id", input.sessionID))!;
      }).pipe(sql.withTransaction),
  };
});
