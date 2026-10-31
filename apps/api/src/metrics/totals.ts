import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { koreaDay, type MetricTotal, type MetricsQuery, VisitSource } from "@ren-ai/onboarding";

export const counterSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS metric_total (
    day TEXT NOT NULL, step TEXT NOT NULL, dimension TEXT NOT NULL, value TEXT NOT NULL,
    count REAL NOT NULL, PRIMARY KEY(day, dimension, step, value)) WITHOUT ROWID`;
  yield* sql`CREATE INDEX IF NOT EXISTS metric_read ON metric_total(dimension, day, step, value)`;
  yield* sql`CREATE TABLE IF NOT EXISTS metric_dimension_value (
    day TEXT NOT NULL, dimension TEXT NOT NULL, value TEXT NOT NULL, slot INTEGER NOT NULL,
    PRIMARY KEY(day, dimension, value), UNIQUE(day, dimension, slot)) WITHOUT ROWID`;
});

const boundedValue = (day: string, dimension: string, value: string) =>
  Effect.gen(function* () {
    if (dimension !== "source" && dimension !== "persona") return value;
    const sql = yield* SqlClient.SqlClient;
    if (
      (yield* sql`SELECT 1 FROM metric_dimension_value WHERE day = ${day} AND dimension = ${dimension} AND value = ${value}`)
        .length
    )
      return value;
    const [last] = yield* sql<{
      slot: number;
    }>`SELECT slot FROM metric_dimension_value WHERE day = ${day} AND dimension = ${dimension} ORDER BY slot DESC LIMIT 1`;
    const slot = (last?.slot ?? 0) + 1;
    if (slot > 256) return "other";
    yield* sql`INSERT INTO metric_dimension_value(day, dimension, value, slot) VALUES (${day}, ${dimension}, ${value}, ${slot})`;
    return value;
  });
export const sourceValue = (source: VisitSource | undefined) =>
  source
    ? JSON.stringify([source.entry, source.referrer, source.source, source.medium, source.campaign])
    : "unknown";
const StoredSource = Schema.fromJsonString(
  Schema.Tuple([
    VisitSource.fields.entry,
    Schema.String,
    Schema.String,
    Schema.String,
    Schema.String,
  ]),
);
const entries = {
  home: "홈",
  about: "소개",
  explore: "둘러보기",
  profile: "공유 프로필",
  reselection: "재선택 링크",
};
/** Names a stored Source value for the Operator, such as `example.org · friends/social/launch · 홈`. */
export const sourceLabel = (value: string) => {
  if (value === "other") return "기타 경로";
  return Option.match(Schema.decodeUnknownOption(StoredSource)(value), {
    onNone: () => "경로 정보 없음",
    onSome: ([entry, referrer, ...tags]) =>
      [referrer || "직접 방문", tags.filter(Boolean).join("/"), entries[entry]]
        .filter(Boolean)
        .join(" · "),
  });
};
export const countryValue = (country: string | null) =>
  country && /^[A-Z]{2}$/.test(country) ? country : "unknown";
export type Dimensions = ReadonlyArray<readonly [MetricTotal["dimension"], string]>;

export const countMetric = (
  step: MetricTotal["step"],
  at: number,
  dimensions: Dimensions,
  amount = 1,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const day = koreaDay(at);
    for (const [dimension, original] of [["total", ""], ...dimensions] as Dimensions) {
      const value = yield* boundedValue(day, dimension, original);
      yield* sql`INSERT INTO metric_total(day, step, dimension, value, count)
        VALUES (${day}, ${step}, ${dimension}, ${value}, ${amount})
        ON CONFLICT(day, dimension, step, value) DO UPDATE SET count = count + excluded.count`;
    }
  });

export const readTotals = (query: MetricsQuery, dimension = query.breakdown ?? "total") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<MetricTotal>`SELECT day, step, dimension, value, count FROM metric_total
    WHERE day >= ${query.from} AND day <= ${query.to} AND dimension = ${dimension} AND count != 0 ORDER BY day, step, value`;
  });

export const previousPeriod = (query: MetricsQuery) => {
  const duration = Date.parse(query.to) - Date.parse(query.from) + 86_400_000;
  return {
    from: new Date(Date.parse(query.from) - duration).toISOString().slice(0, 10),
    to: new Date(Date.parse(query.from) - 86_400_000).toISOString().slice(0, 10),
  };
};
