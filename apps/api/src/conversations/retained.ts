import { Clock, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Session } from "@opencode/schema/session";
import type { PersonaRuntime } from "../opencode/runtime.ts";
import { timestamp } from "../transcript/transcript.ts";

export const retainedSessions = (host: PersonaRuntime) => {
  const stop = (sessionID: string, title: string) =>
    Effect.gen(function* () {
      const id = Session.ID.make(sessionID);
      yield* host.sessions.interrupt(id);
      yield* host.sessions.wait(id);
      for (const item of yield* host.sessions.inbox(id))
        yield* host.sessions.cancelInbox({ sessionID: id, inboxID: item.id });
      yield* host.sessions.rename({ sessionID: id, title });
    }).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void));
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const resume = Effect.gen(function* () {
      for (const row of yield* sql<{ sessionID: string; title: string }>`
        SELECT session_id AS sessionID, title FROM retained_session`)
        yield* stop(row.sessionID, row.title);
    });
    const retainRemoved = (sessionID: string, handle: string) =>
      Effect.gen(function* () {
        const id = Session.ID.make(sessionID);
        const session = yield* host.sessions.get(id);
        const persona = host.personas.get(session.agent!)!;
        const at = yield* Clock.currentTimeMillis;
        const title = `${persona.id[0]!.toUpperCase()}${persona.id.slice(1)} · ${handle} · removed ${timestamp(at, persona.timeZone)}`;
        yield* sql`INSERT OR IGNORE INTO retained_session (session_id, handle, title) VALUES (${id}, ${handle}, ${title})`;
        yield* resume;
      });
    return { resume, retainRemoved };
  });
};
