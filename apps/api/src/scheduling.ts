import { Clock, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const safetyInterval = 300_000;

/** Persisted deadlines, never a timer tied to the lifetime of an actor. */
export const scheduleWork = (name: string, due: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO application_work (name, due) VALUES (${name}, ${due})
    ON CONFLICT(name) DO UPDATE SET due = MIN(due, excluded.due), generation = generation + 1`;
  });

export const scheduledApplicationWork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  return yield* sql<{
    name: string;
    generation: number;
  }>`SELECT name, generation FROM application_work WHERE due <= ${now} AND name != 'retry'`;
});

export const nextApplicationWake = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const [row] = yield* sql<{ due: number | null }>`SELECT MIN(due) AS due FROM (
    SELECT scheduled_at AS due FROM discovery_contact WHERE state = 'scheduled'
    UNION ALL SELECT next_wake_at FROM follow_up WHERE next_wake_at IS NOT NULL
    UNION ALL SELECT retry_at FROM intake_pending
    UNION ALL SELECT retry_at FROM failed_turn WHERE review = 0
    UNION ALL SELECT created_at + 900001 FROM intake_edit
  )`;
  // Cloudflare SQLite limits compound SELECTs to five terms.
  const [recovery] = yield* sql<{ due: number | null }>`SELECT MIN(due) AS due FROM (
    SELECT 0 AS due FROM conversation c JOIN user u ON u.id = c.user_id WHERE c.rebuilding = 1 AND c.ended_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM blocked WHERE handle = u.handle)
      AND NOT EXISTS (SELECT 1 FROM removal WHERE handle = u.handle)
    UNION ALL SELECT c.ended_at FROM conversation_end e JOIN conversation c ON c.id = e.conversation_id WHERE e.stopped_at IS NULL
    UNION ALL SELECT last_checked + ${safetyInterval} FROM conversation_end e JOIN conversation c ON c.id = e.conversation_id
      JOIN user u ON u.id = c.user_id WHERE (e.farewell_pending = 1 OR e.notice_pending = 1) AND e.consumed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM blocked WHERE handle = u.handle)
      AND NOT EXISTS (SELECT 1 FROM removal WHERE handle = u.handle)
      AND NOT EXISTS (SELECT 1 FROM conversation a WHERE a.user_id = u.id AND a.ended_at IS NULL)
  )`;
  const [direct] = yield* sql<{
    due: number | null;
  }>`SELECT MIN(due) AS due FROM application_work WHERE name != 'retry'`;
  const [retry] = yield* sql<{
    due: number;
    attempts: number;
  }>`SELECT due, attempts FROM application_work WHERE name = 'retry'`;
  const due = Math.min(
    direct?.due ?? now + safetyInterval,
    Math.max(
      retry?.due ?? 0,
      Math.min(row?.due ?? now + safetyInterval, recovery?.due ?? now + safetyInterval),
    ),
  );
  return Math.max(now + 1, retry?.attempts ? retry.due : 0, due);
});

export const finishApplicationWork = (
  work: ReadonlyArray<{ name: string; generation: number }>,
  failed: boolean,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    if (!failed)
      for (const entry of work)
        yield* sql`DELETE FROM application_work WHERE name = ${entry.name} AND generation = ${entry.generation}`;
    const [previous] = yield* sql<{
      attempts: number;
    }>`SELECT attempts FROM application_work WHERE name = 'retry'`;
    const attempts = failed ? (previous?.attempts ?? 0) + 1 : 0;
    // Failed external work and unresolved sends cannot create a hot alarm loop.
    const delay = failed
      ? Math.min(30_000 * 2 ** Math.min(attempts - 1, 4), safetyInterval)
      : 30_000;
    yield* sql`INSERT INTO application_work (name, due, attempts) VALUES ('retry', ${now + delay}, ${attempts})
    ON CONFLICT(name) DO UPDATE SET due = excluded.due, attempts = excluded.attempts`;
    yield* sql`INSERT INTO application_work (name, due) VALUES ('maintenance', ${now + safetyInterval})
    ON CONFLICT(name) DO NOTHING`;
  });
