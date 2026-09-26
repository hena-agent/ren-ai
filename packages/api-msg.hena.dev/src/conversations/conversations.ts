import { Clock, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export interface Conversation {
  readonly id: number;
  readonly handle: string;
  readonly personaID: string;
  readonly sessionID: string;
}

export const conversations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lookup = (column: "handle" | "session_id", value: string) =>
    Effect.map(
      sql<Conversation>`SELECT conversation.id, user.handle, conversation.persona_id AS personaID,
        conversation.session_id AS sessionID FROM conversation
        JOIN user ON user.id = conversation.user_id
        WHERE ${sql(column)} = ${value}`,
      (rows) => rows[0],
    );
  return {
    byHandle: (handle: string) => lookup("handle", handle),
    bySession: (sessionID: string) => lookup("session_id", sessionID),
    create: (input: {
      handle: string;
      locale: string;
      consentVersion: string;
      consentLanguage: string;
      personaID: string;
      sessionID: string;
    }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at, joined_at)
          VALUES (${input.handle}, ${input.locale}, ${input.consentVersion}, ${input.consentLanguage}, ${now}, ${now})`;
        yield* sql`INSERT INTO conversation (user_id, persona_id, session_id, started_at)
          VALUES ((SELECT id FROM user WHERE handle = ${input.handle}), ${input.personaID}, ${input.sessionID}, ${now})`;
        return (yield* lookup("session_id", input.sessionID))!;
      }).pipe(sql.withTransaction),
  };
});
