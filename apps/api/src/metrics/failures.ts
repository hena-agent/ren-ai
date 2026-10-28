import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { DiscoveryRequest } from "@ren-ai/onboarding";
import { countMetric, countryValue, sourceValue } from "./totals.ts";
import { changeAlert } from "./alerts.ts";
import { scheduleWork } from "../scheduling.ts";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";

export const failedJoin = (
  input: DiscoveryRequest,
  reason: string,
  country: string | null,
  system: boolean,
  requestId: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.gen(function* () {
      if (!(yield* sql`SELECT 1 FROM test_handle WHERE handle = ${input.handle}`).length)
        yield* countMetric("join_failed", now, [
          ["reason", reason],
          ["source", sourceValue(input.source)],
          ["country", countryValue(country)],
          ["joining", input.reselectionToken ? "reselection" : "first"],
          ["relationship", input.startingRelationship ?? "dating"],
          ["language", input.conversationLanguage ?? input.locale],
        ]);
      if (!system) return;
      yield* sql`INSERT INTO metric_join_failure(at) VALUES (${now})`;
      yield* sql`DELETE FROM metric_join_failure WHERE id NOT IN (SELECT id FROM metric_join_failure ORDER BY id DESC LIMIT 3)`;
      const [count] = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM metric_join_failure WHERE at > ${now - 3_600_000}`;
      if (count!.count >= 3) yield* changeAlert("joins-failing", true);
      yield* scheduleWork("metric-alerts", now + 3_600_000);
    }).pipe(sql.withTransaction);
  }).pipe(
    Effect.catch((cause) =>
      Effect.sync(() =>
        contactLog({
          requestId,
          operation: "metrics.join",
          stage: "failure.count",
          outcome: "failed",
          durationMs: 0,
          level: "error",
          ...contactCause(cause),
        }),
      ),
    ),
  );

export const expireMetricAlerts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    let due = Number.POSITIVE_INFINITY;
    const [last] = yield* sql<{ at: number | null }>`SELECT MAX(at) AS at FROM metric_join_failure`;
    if (last!.at !== null && last!.at <= now - 3_600_000) {
      yield* changeAlert("joins-failing", false);
      yield* sql`DELETE FROM metric_join_failure`;
    } else if (last!.at !== null) due = last!.at + 3_600_000;
    const raised = yield* sql`SELECT 1 FROM application_alert WHERE name = 'notification-cap'`;
    if (raised.length) {
      const [count] = yield* sql<{
        count: number;
        first: number;
      }>`SELECT COUNT(*) AS count, MIN(at) AS first FROM notification_attempt WHERE at > ${now - 3_600_000}`;
      if (count!.count < 30) yield* changeAlert("notification-cap", false);
      else due = Math.min(due, count!.first + 3_600_000);
    }
    if (Number.isFinite(due))
      yield* sql`INSERT INTO application_work(name, due) VALUES ('metric-alerts', ${due})
        ON CONFLICT(name) DO UPDATE SET due = excluded.due, generation = generation + 1 WHERE due != excluded.due`;
    else yield* sql`DELETE FROM application_work WHERE name = 'metric-alerts'`;
  }).pipe(sql.withTransaction);
});
