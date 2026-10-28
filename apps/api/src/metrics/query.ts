import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { MetricsQuery, type Metrics, MetricTotal } from "@ren-ai/onboarding";
import { previousPeriod, readTotals } from "./totals.ts";
import { authorize } from "@ren-ai/transport/server";
import type { ApplicationStore } from "../application-store.ts";
import { discordState, type Webhooks } from "./discord.ts";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";

const totals = (q: MetricsQuery) =>
  Effect.gen(function* () {
    const rows = yield* readTotals(q, "total");
    return q.breakdown && q.breakdown !== "total" ? [...rows, ...(yield* readTotals(q))] : rows;
  });

const metricsRead = (query: MetricsQuery, webhooks: Webhooks) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const previous = previousPeriod(query);
    const costs = (q: MetricsQuery) => sql<{
      day: string;
      cost: number;
      conversations: number;
    }>`SELECT date(e.started_at / 1000, 'unixepoch', '+9 hours') AS day, SUM(COALESCE(e.cost, 0)) AS cost, COUNT(DISTINCT s.conversation_key) AS conversations
    FROM usage_entry e JOIN usage_session s ON s.session_id = e.session_id WHERE e.started_at >= ${Date.parse(`${q.from}T00:00:00+09:00`)} AND e.started_at < ${Date.parse(`${q.to}T00:00:00+09:00`) + 86_400_000}
    AND e.started_at >= (SELECT at FROM metric_epoch) AND e.metric_excluded = 0 GROUP BY day ORDER BY day`;
    const alerts = yield* sql<
      Metrics["alerts"][number]
    >`SELECT name, raised_at AS raisedAt, detail, url FROM application_alert ORDER BY raised_at, name`;
    return {
      ...query,
      previousFrom: previous.from,
      previousTo: previous.to,
      totals: yield* totals(query),
      previous: yield* totals({ ...query, ...previous }),
      personas: yield* readTotals(query, "persona"),
      previousPersonas: yield* readTotals(previous, "persona"),
      endings: yield* readTotals(query, "initiator"),
      previousEndings: yield* readTotals(previous, "initiator"),
      cost: yield* costs(query),
      previousCost: yield* costs(previous),
      alerts,
      delivery: yield* discordState(webhooks),
    } satisfies Metrics;
  });

export const loadMetrics = async (
  query: MetricsQuery,
  run: ApplicationStore["run"],
  webhooks: Webhooks,
  activity?: (request: Request) => Promise<Response>,
) => {
  const result = await run(metricsRead(query, webhooks));
  if (activity) {
    const browser = async (q: MetricsQuery, includeTotals = false) => {
      const response = await activity(
        new Request(`https://metrics/?${new URLSearchParams(q).toString()}`),
      );
      if (!response.ok) throw new Error("Activity Metrics unavailable");
      const rows = [...Schema.decodeUnknownSync(Schema.Array(MetricTotal))(await response.json())];
      if (includeTotals && q.breakdown && q.breakdown !== "total") {
        const total = await activity(
          new Request(
            `https://metrics/?${new URLSearchParams({ ...q, breakdown: "total" }).toString()}`,
          ),
        );
        if (!total.ok) throw new Error("Activity Metrics unavailable");
        rows.push(...Schema.decodeUnknownSync(Schema.Array(MetricTotal))(await total.json()));
      }
      return rows;
    };
    const [current, previous, personas, previousPersonas] = await Promise.all([
      browser(query, true),
      browser({ ...query, ...previousPeriod(query) }, true),
      browser({ ...query, breakdown: "persona" }),
      browser({ ...query, ...previousPeriod(query), breakdown: "persona" }),
    ]);
    result.totals = [...result.totals, ...current];
    result.previous = [...result.previous, ...previous];
    result.personas = [...result.personas, ...personas];
    result.previousPersonas = [...result.previousPersonas, ...previousPersonas];
  }
  return result;
};

export const metricsHandler = (
  run: ApplicationStore["run"],
  token: string,
  webhooks: Webhooks,
  activity?: (request: Request) => Promise<Response>,
) => {
  if (!token) return async () => new Response(null, { status: 401 });
  return authorize(async (request) => {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    let query: MetricsQuery;
    try {
      query = Schema.decodeUnknownSync(MetricsQuery)(
        Object.fromEntries(new URL(request.url).searchParams),
      );
    } catch (cause) {
      contactLog({
        requestId: request.headers.get("X-Operation-ID")!,
        operation: "metrics.read",
        stage: "range.validate",
        outcome: "failed",
        level: "warn",
        durationMs: 0,
        code: "invalid_metrics_range",
        ...contactCause(cause),
      });
      return new Response(null, { status: 400 });
    }
    const result = await loadMetrics(query, run, webhooks, activity);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  }, token);
};
