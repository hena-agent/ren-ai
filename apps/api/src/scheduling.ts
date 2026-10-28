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
  }>`SELECT name, generation FROM application_work WHERE due <= ${now} AND name != 'retry' ORDER BY due, name LIMIT 5`;
});

/** Work the application store completes without starting conversation execution. */
const storeWork = new Set(["metrics-report", "metric-alerts", "discord"]);
export const isStoreWork = (name: string) => storeWork.has(name);

const delayed = (due: number | null | undefined, floor: number) =>
  due == null ? Number.POSITIVE_INFINITY : Math.max(due, floor);
const laneFloor = (lanes: ReadonlyMap<string, number>, name: string) =>
  Math.max(
    lanes.get("lane:alarm.cursor:execution") ?? 0,
    lanes.get(`lane:execution.cursor:${name}`) ?? 0,
  );
const directDeadline = (name: string, due: number, lanes: ReadonlyMap<string, number>) => {
  if (name.startsWith("lane:alarm.cursor:")) return due;
  if (name === "notifications")
    return delayed(due, lanes.get("lane:alarm.cursor:notifications") ?? 0);
  return delayed(due, laneFloor(lanes, name === "intake" ? "intake" : "execution"));
};

/** Persisted deadlines only: an idle application has no wake, and store work never waits for execution. */
export const applicationWakes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const fixed = yield* sql<{
    name: string;
    due: number;
  }>`SELECT name, due FROM application_work INDEXED BY work_fixed WHERE name NOT GLOB 'turn:*' AND name != 'retry'`;
  const lanes = new Map(fixed.map((row) => [row.name, row.due]));
  const [row] = yield* sql<{
    contacts: number | null;
    followUps: number | null;
    intake: number | null;
    failures: number | null;
    edits: number | null;
    attempts: number | null;
    verifications: number | null;
    photos: number | null;
  }>`SELECT
    (SELECT MIN(scheduled_at) FROM discovery_contact WHERE state = 'scheduled') AS contacts,
    (SELECT MIN(next_wake_at) FROM follow_up WHERE next_wake_at IS NOT NULL) AS followUps,
    (SELECT MIN(retry_at) FROM intake_handle) AS intake,
    (SELECT MIN(retry_at) FROM failed_turn WHERE review = 0) AS failures,
    (SELECT MIN(created_at) + 900001 FROM intake_edit) AS edits,
    (SELECT MIN(due) FROM photo_object WHERE due IS NOT NULL) AS photos,
    (SELECT MIN(at) + 3600000 FROM discovery_attempt) AS attempts,
    (SELECT MIN(at) + 60000 FROM discovery_verification) AS verifications`;
  const [recovery] = yield* sql<{
    rebuilds: number | null;
    stopped: number | null;
    endings: number | null;
  }>`SELECT
    (SELECT 0 WHERE EXISTS (SELECT 1 FROM conversation c JOIN user u ON u.id = c.user_id WHERE c.rebuilding = 1 AND c.ended_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM blocked WHERE handle = u.handle)
      AND NOT EXISTS (SELECT 1 FROM removal WHERE handle = u.handle))) AS rebuilds,
    (SELECT MIN(c.ended_at) FROM conversation_end e JOIN conversation c ON c.id = e.conversation_id WHERE e.stopped_at IS NULL) AS stopped,
    (SELECT MIN(last_checked) + ${safetyInterval} FROM conversation_end e JOIN conversation c ON c.id = e.conversation_id
      JOIN user u ON u.id = c.user_id WHERE (e.farewell_pending = 1 OR e.notice_pending = 1) AND e.consumed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM blocked WHERE handle = u.handle)
      AND NOT EXISTS (SELECT 1 FROM removal WHERE handle = u.handle)
      AND NOT EXISTS (SELECT 1 FROM conversation a WHERE a.user_id = u.id AND a.ended_at IS NULL)) AS endings`;
  const [turns] = yield* sql<{
    due: number | null;
  }>`SELECT MIN(due) AS due FROM application_work INDEXED BY work_turn_due WHERE name GLOB 'turn:*'`;
  const [retry] = yield* sql<{
    due: number;
    attempts: number;
  }>`SELECT due, attempts FROM application_work WHERE name = 'retry'`;
  const backoff = retry?.attempts ? retry.due : Number.POSITIVE_INFINITY;
  const execution = Math.min(
    delayed(row!.contacts, laneFloor(lanes, "contacts")),
    delayed(row!.followUps, laneFloor(lanes, "followUps")),
    delayed(row!.intake, laneFloor(lanes, "intake")),
    delayed(row!.failures, laneFloor(lanes, "turns")),
    delayed(row!.edits, laneFloor(lanes, "intake")),
    delayed(row!.photos, laneFloor(lanes, "photos")),
    delayed(recovery!.rebuilds, laneFloor(lanes, "rebuilds")),
    delayed(recovery!.stopped, laneFloor(lanes, "stopped")),
    delayed(recovery!.endings, laneFloor(lanes, "endings")),
    delayed(turns!.due, laneFloor(lanes, "turns")),
    ...fixed
      .filter((entry) => !isStoreWork(entry.name))
      .map((entry) => directDeadline(entry.name, entry.due, lanes)),
    backoff,
  );
  return {
    store: Math.min(
      ...fixed.filter((entry) => isStoreWork(entry.name)).map((entry) => entry.due),
      delayed(row!.attempts, now + 1_000),
      delayed(row!.verifications, now + 1_000),
    ),
    // A failed tick's backoff holds every execution deadline until its retry.
    execution: Number.isFinite(backoff) ? Math.max(backoff, execution) : execution,
  };
});

/** The next alarm time, or undefined when no persisted work remains. */
export const nextApplicationWake = Effect.gen(function* () {
  const { store, execution } = yield* applicationWakes;
  const due = Math.min(store, execution);
  if (!Number.isFinite(due)) return undefined;
  return Math.max((yield* Clock.currentTimeMillis) + 1, due);
});

export type WorkOutcome = "completed" | "failed" | "deferred" | "store-only";

export const finishApplicationWork = (
  work: ReadonlyArray<{ name: string; generation: number }>,
  outcome: WorkOutcome,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    if (outcome === "completed" || outcome === "store-only")
      for (const entry of work)
        yield* sql`DELETE FROM application_work WHERE name = ${entry.name} AND generation = ${entry.generation}
          AND name NOT LIKE 'turn:%' AND name NOT LIKE 'lane:%'`;
    // Execution did not run, so its failure backoff stays in force.
    if (outcome === "store-only") return;
    const [previous] = yield* sql<{
      attempts: number;
    }>`SELECT attempts FROM application_work WHERE name = 'retry'`;
    const attempts =
      outcome === "deferred" ? 1 : outcome === "failed" ? (previous?.attempts ?? 0) + 1 : 0;
    // Failed external work and unresolved sends cannot create a hot alarm loop.
    const delay =
      outcome === "deferred"
        ? 1_000
        : outcome === "failed"
          ? Math.min(30_000 * 2 ** Math.min(attempts - 1, 4), safetyInterval)
          : 30_000;
    yield* sql`INSERT INTO application_work (name, due, attempts) VALUES ('retry', ${now + delay}, ${attempts})
    ON CONFLICT(name) DO UPDATE SET due = excluded.due, attempts = excluded.attempts`;
  });
