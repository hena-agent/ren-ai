import { Array, Clock, Deferred, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Each notification belongs to one session, including across a Conversation's reset. */
export const timing = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pending = new Map<string, Deferred.Deferred<void>>();
  const onNew = (id: string, messageID: string) =>
    Effect.gen(function* () {
      const until = (yield* Clock.currentTimeMillis) + 4000;
      const rows =
        yield* sql`INSERT OR IGNORE INTO reply_arrival (session_id, message_id, quiet_until)
      VALUES (${id}, ${messageID}, ${until}) RETURNING message_id`;
      if (!rows.length) return;
      const signal = pending.get(id);
      pending.delete(id);
      if (signal) yield* Deferred.succeed(signal, undefined);
    });
  const during = <A, E, R>(id: string, action: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      let signal = pending.get(id);
      if (!signal) {
        signal = yield* Deferred.make<void>();
        pending.set(id, signal);
      }
      const unseen =
        yield* sql`SELECT 1 FROM reply_arrival WHERE session_id = ${id} AND seen = 0 LIMIT 1`;
      if (unseen.length) return "new" as const;
      const result = yield* Effect.race(action, Effect.as(Deferred.await(signal), "new" as const));
      return (yield* Deferred.isDone(signal)) ? "new" : result;
    });
  const wait = (id: string, seconds: number) =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis;
      // Finish before OpenCode's 60-minute inactivity eviction so the persona can wait again.
      const duration = Math.min(seconds, 3300);
      const outcome = yield* during(id, Effect.sleep(duration * 1000));
      const elapsed = Math.floor(((yield* Clock.currentTimeMillis) - start) / 1000);
      return outcome === "new"
        ? `paused ${elapsed}s, cut short by something new`
        : `paused ${duration}s`;
    });
  const quiet = (id: string) =>
    Effect.gen(function* () {
      const [latest] = yield* sql<{
        until: number | null;
      }>`SELECT MAX(quiet_until) AS until FROM reply_arrival WHERE session_id = ${id}`;
      const until = latest!.until;
      if (until === null) return;
      yield* Effect.sleep(Math.max(0, until - (yield* Clock.currentTimeMillis)));
    });
  const seen = (id: string, messageIDs: readonly string[]) =>
    // Cloudflare SQLite allows 100 bindings; reserve one for the session ID.
    Effect.forEach(
      Array.chunksOf(messageIDs, 99),
      (batch) =>
        sql`UPDATE reply_arrival SET seen = 1 WHERE session_id = ${id} AND ${sql.in("message_id", batch)}`,
      { discard: true },
    );
  return { onNew, during, wait, quiet, seen };
});
