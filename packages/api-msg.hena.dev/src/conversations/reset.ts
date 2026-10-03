import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Session } from "@opencode/schema/session";
import type { conversations } from "./conversations.ts";
import type { PersonaRuntime } from "../opencode/runtime.ts";
import type { IncomingMessage, Messages } from "../messages/messages.ts";
import { timestamp } from "../transcript/transcript.ts";
import { retainedSessions } from "./retained.ts";
import { resetBoundary } from "./reset-boundary.ts";
import { withLifecycle } from "./lifecycle.ts";

export const resets = (
  directory: Effect.Success<typeof conversations>,
  host: PersonaRuntime,
  forget: (sessionID: string) => Effect.Effect<void>,
  messages: Messages,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const retained = yield* retainedSessions(host);
    const beforeReset = yield* resetBoundary(messages);
    const finish = (guid: string) =>
      Effect.gen(function* () {
        if (!(yield* sql`SELECT 1 FROM reset WHERE guid = ${guid} AND complete = 0`).length) return;
        yield* retained.resume;
        yield* withLifecycle(
          sql.withTransaction(
            Effect.gen(function* () {
              // Also finish resets recorded by the previous memory-only implementation.
              yield* sql`DELETE FROM user WHERE id IN (SELECT user_id FROM conversation WHERE reset_guid = ${guid})`;
              yield* sql`UPDATE reset SET complete = 1 WHERE guid = ${guid}`;
            }),
          ),
        );
      });
    const receive = (row: IncomingMessage) =>
      Effect.gen(function* () {
        if (row.fromMe || row.tapback || row.text.trim().toLowerCase() !== "/reset") return;
        yield* directory.withHandle(row.handle)(
          Effect.gen(function* () {
            if ((yield* sql`SELECT 1 FROM reset WHERE guid = ${row.guid}`).length) {
              yield* finish(row.guid);
              return;
            }
            if ((yield* sql`SELECT 1 FROM intake_seen WHERE guid = ${row.guid}`).length) return;
            if (yield* beforeReset(row)) return;
            if (!(yield* sql`SELECT 1 FROM test_handle WHERE handle = ${row.handle}`).length)
              return;
            const oldID = yield* withLifecycle(
              Effect.gen(function* () {
                const conversation = yield* directory.byHandle(row.handle);
                if (!conversation) return undefined;
                const persona = host.personas.get(conversation.personaID)!;
                const sessionID = Session.ID.make(conversation.sessionID);
                const title = `${persona.id[0]!.toUpperCase()}${persona.id.slice(1)} · ${row.handle} · reset ${timestamp(row.createdAt, persona.timeZone)}`;
                yield* sql.withTransaction(
                  Effect.gen(function* () {
                    yield* sql`INSERT INTO retained_session (session_id, handle, title)
                VALUES (${sessionID}, ${row.handle}, ${title})`;
                    yield* sql`INSERT INTO reset (guid, handle, row_id, date, session_id, notice_id)
                VALUES (${row.guid}, ${row.handle}, ${row.id}, ${row.createdAt}, ${sessionID},
                  COALESCE((SELECT MAX(id) FROM send WHERE handle = ${row.handle} AND kind = 'notice'), 0))`;
                    yield* sql`DELETE FROM user WHERE handle = ${row.handle}`;
                  }),
                );
                return sessionID;
              }),
            );
            if (!oldID) return;
            yield* forget(oldID);
            yield* finish(row.guid);
          }),
        );
      });
    const resume = Effect.gen(function* () {
      for (const row of yield* sql<{ guid: string }>`SELECT guid FROM reset WHERE complete = 0`)
        yield* finish(row.guid);
    });
    return { receive, resume };
  });
