import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Recreate the deployed predecessor for forward-upgrade tests. */
export const rewindMetrics = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "invitation_submission",
    "invitation_redemption",
    "invitation",
    "invitation_delivery",
    "invitation_grant",
    "invitation_settings",
  ])
    yield* sql`DROP TABLE ${sql(table)}`;
  yield* sql`DROP TRIGGER usage_test_exclusion`;
  yield* sql`DROP TRIGGER usage_entry_test_exclusion`;
  yield* sql`DROP INDEX usage_entry_date`;
  for (const table of [
    "metric_total",
    "metric_dimension_value",
    "metric_receipt",
    "metric_join_failure",
    "metric_epoch",
    "discord_outbox",
    "discord_delivery",
    "metrics_report",
  ])
    yield* sql`DROP TABLE ${sql(table)}`;
  for (const [table, columns] of [
    ["application_alert", ["raised_at", "detail", "url"]],
    ["discovery_registration", ["metric_source", "metric_country", "metric_joining", "hidden"]],
    ["conversation", ["metric_greeting_at", "metric_active_day", "metric_flags"]],
    ["usage_session", ["metric_excluded", "metric_excluded_until"]],
    ["usage_entry", ["metric_excluded"]],
  ] as const)
    for (const column of columns) yield* sql`ALTER TABLE ${sql(table)} DROP COLUMN ${sql(column)}`;
  yield* sql`DELETE FROM application_work WHERE name = 'metrics-report'`;
  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 55`;
});
