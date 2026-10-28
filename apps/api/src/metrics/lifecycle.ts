import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
  koreaDay,
  MetricDimension,
  MetricStep,
  type DiscoveryRequest,
  type MetricTotal,
} from "@ren-ai/onboarding";
import { countMetric, sourceValue, countryValue, type Dimensions } from "./totals.ts";
import { changeAlert } from "./alerts.ts";

const DimensionsSchema = Schema.Array(Schema.Tuple([MetricDimension, Schema.String]));
export const registrationMetric = (
  id: string,
  input: DiscoveryRequest,
  country: string | null,
  joining: "first" | "reselection",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE discovery_registration SET metric_source = ${sourceValue(input.source)}, metric_country = ${countryValue(country)}, metric_joining = ${joining} WHERE id = ${id}`;
    yield* lifecycleMetric(
      id,
      "join",
      undefined,
      input.likedPersonaIDs.map((persona) => ["persona", persona] as const),
    );
  });

export const lifecycleMetric = (
  registrationID: string,
  step: MetricTotal["step"],
  persona?: string,
  extra: Dimensions = [],
  conversationID: number | null = null,
  at?: number,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = at ?? (yield* Clock.currentTimeMillis);
    const [row] = yield* sql<{
      source: string;
      country: string;
      joining: string;
      relationship: string;
      language: string;
    }>`SELECT r.metric_source AS source, r.metric_country AS country, r.metric_joining AS joining,
    COALESCE(r.starting_relationship, 'unknown') AS relationship, COALESCE(l.conversation_language, r.locale) AS language
    FROM discovery_registration r LEFT JOIN discovery_language l ON l.registration_id = r.id
    WHERE r.id = ${registrationID}
    AND NOT EXISTS(SELECT 1 FROM test_handle t WHERE t.handle = r.handle)`;
    if (!row) return;
    if (
      step !== "active" &&
      (yield* sql`SELECT 1 FROM metric_receipt WHERE registration_id = ${registrationID} AND step = ${step} LIMIT 1`)
        .length
    )
      return;
    const dimensions: Dimensions = [
      ["source", row.source],
      ["country", row.country],
      ["joining", row.joining],
      ["relationship", row.relationship],
      ["language", row.language],
      ...extra,
      ...(persona ? [["persona", persona] as const] : []),
    ];
    const receipt =
      yield* sql`INSERT OR IGNORE INTO metric_receipt(registration_id, conversation_id, step, day, dimensions)
    VALUES (${registrationID}, ${conversationID}, ${step}, ${koreaDay(now)}, ${JSON.stringify(dimensions)}) RETURNING step`;
    if (receipt.length) yield* countMetric(step, now, dimensions);
  });

export const excludeMetrics = (handle: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      step: typeof MetricStep.Type;
      day: string;
      dimensions: string;
    }>`SELECT step, day, dimensions FROM metric_receipt
    WHERE registration_id IN (SELECT id FROM discovery_registration WHERE handle = ${handle})`;
    for (const row of rows)
      yield* countMetric(
        row.step,
        Date.parse(`${row.day}T00:00:00+09:00`),
        Schema.decodeUnknownSync(Schema.fromJsonString(DimensionsSchema))(row.dimensions),
        -1,
      );
    yield* sql`DELETE FROM metric_receipt WHERE registration_id IN (SELECT id FROM discovery_registration WHERE handle = ${handle})`;
    yield* sql`UPDATE conversation SET metric_active_day = NULL WHERE user_id IN (SELECT id FROM user WHERE handle = ${handle})`;
    yield* sql`UPDATE usage_session SET metric_excluded = 1 WHERE conversation_key IN (SELECT c.usage_key FROM conversation c JOIN user u ON u.id = c.user_id WHERE u.handle = ${handle})`;
    yield* sql`UPDATE usage_entry SET metric_excluded = 1 WHERE session_id IN (SELECT s.session_id FROM usage_session s JOIN conversation c ON c.usage_key = s.conversation_key JOIN user u ON u.id = c.user_id WHERE u.handle = ${handle}) AND metric_excluded = 0`;
  });

export const resumeMetrics = (handle: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    yield* sql`UPDATE usage_session SET metric_excluded = 0, metric_excluded_until = ${now} WHERE conversation_key IN (SELECT c.usage_key FROM conversation c JOIN user u ON u.id = c.user_id WHERE u.handle = ${handle}) AND metric_excluded = 1`;
  });

export const clearMetricAlerts = (handle: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      name: string;
    }>`SELECT name FROM application_alert WHERE name IN (SELECT 'greeting:' || id FROM discovery_registration WHERE handle = ${handle})`;
    for (const row of rows) yield* changeAlert(row.name, false);
  });
