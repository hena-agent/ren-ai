import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { Metrics, MetricsQuery } from "@ren-ai/onboarding";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";
import { dailyReport } from "./report.ts";
import { deliverDiscord, type Webhooks } from "./discord.ts";
import { expireMetricAlerts } from "./failures.ts";

export const metricsTasks = (
  load: (query: MetricsQuery) => Promise<Metrics>,
  webhooks: Webhooks,
  fetcher: typeof fetch,
  requestId: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tasks: ReadonlyArray<readonly [string, Effect.Effect<void, Error, SqlClient.SqlClient>]> =
      [
        ["metric-alerts", expireMetricAlerts],
        ["metrics-report", dailyReport(load).pipe(Effect.timeout("5 seconds"))],
        ["discord", deliverDiscord(webhooks, fetcher, requestId)],
      ];
    for (const [name, task] of tasks) {
      const now = yield* Clock.currentTimeMillis;
      const [retry] = yield* sql<{
        due: number;
      }>`SELECT due FROM application_work WHERE name = ${name} AND attempts > 0`;
      if (retry && retry.due > now) continue;
      const started = performance.now();
      yield* task.pipe(
        Effect.tap(
          () => sql`UPDATE application_work SET attempts = 0 WHERE name = ${name} AND attempts > 0`,
        ),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            contactLog({
              requestId,
              operation: "metrics.task",
              stage: name,
              outcome: "failed",
              level: "error",
              durationMs: performance.now() - started,
              ...contactCause(cause),
            });
            yield* sql`INSERT INTO application_work(name, due, attempts) VALUES (${name}, ${(yield* Clock.currentTimeMillis) + 60_000}, 1)
              ON CONFLICT(name) DO UPDATE SET due = excluded.due, attempts = attempts + 1, generation = generation + 1`;
          }),
        ),
      );
    }
  });
