import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { koreaDay, type Metrics, type MetricTotal, type MetricsQuery } from "@ren-ai/onboarding";
import { queueDiscord } from "./discord.ts";

const sum = (rows: readonly MetricTotal[], step: MetricTotal["step"]) =>
  rows
    .filter((row) => row.dimension === "total" && row.step === step)
    .reduce((value, row) => value + row.count, 0);
const share = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
const number = (value: number) =>
  new Intl.NumberFormat("ko", { notation: "compact", maximumFractionDigits: 2 }).format(value);
const lines: ReadonlyArray<readonly [MetricTotal["step"], string]> = [
  ["visit", "방문"],
  ["join", "등록"],
  ["selection", "선정"],
  ["greeting_sent", "인사 전송"],
  ["greeting_failed", "인사 실패"],
  ["greeting_uncertain", "인사 불확실"],
  ["first_reply", "첫 답장"],
  ["active", "활성 사용자"],
];

const compare = (daily: number, before: number, weekly: number, previous: number) =>
  `${number(daily)} / ${number(before)} · ${number(weekly)} / ${number(previous)}`;
const cost = (metrics: Metrics, previous = false) =>
  (previous ? metrics.previousCost : metrics.cost).reduce((total, row) => total + row.cost, 0);
const ending = (metrics: Metrics, initiator: string, previous = false) =>
  (previous ? metrics.previousEndings : metrics.endings)
    .filter((row) => row.value === initiator)
    .reduce((total, row) => total + row.count, 0);

const reportText = (daily: Metrics, weekly: Metrics, cohorts: readonly Metrics[]) => {
  const sources = daily.totals.filter((row) => row.dimension === "source" && row.step === "visit");
  const funnel = [
    ["visit", "방문"],
    ["explore", "둘러보기"],
    ["first_like", "첫 Like"],
    ["join_opened", "등록 양식"],
    ["join", "등록"],
    ["selection", "선정"],
    ["greeting_sent", "인사 전송"],
    ["first_reply", "첫 답장"],
  ] as const;
  const drops = funnel
    .slice(1)
    .map(([step, label], index) => ({
      label: `${funnel[index]![1]} → ${label}`,
      lost: sum(daily.totals, funnel[index]![0]) - sum(daily.totals, step),
    }))
    .toSorted((a, b) => b.lost - a.lost);
  return [
    `Ren AI 일일 보고서 · ${daily.to} (한국 시간)`,
    "어제 / 전일 · 최근 7일 / 이전 7일",
    ...lines.map(
      ([step, label]) =>
        `${label}: ${compare(sum(daily.totals, step), sum(daily.previous, step), sum(weekly.totals, step), sum(weekly.previous, step))}`,
    ),
    `등록률: ${share(sum(daily.totals, "join"), sum(daily.totals, "visit"))} / ${share(sum(daily.previous, "join"), sum(daily.previous, "visit"))} · ${share(sum(weekly.totals, "join"), sum(weekly.totals, "visit"))} / ${share(sum(weekly.previous, "join"), sum(weekly.previous, "visit"))}`,
    `주요 경로: ${
      sources
        .toSorted((a, b) => b.count - a.count)
        .slice(0, 3)
        .map(({ value, count }) => `${value.slice(0, 55)} ${number(count)}`)
        .join(" · ") || "없음"
    }`,
    `최대 이탈: ${drops[0]!.lost > 0 ? `${drops[0]!.label} (${number(drops[0]!.lost)}건)` : "없음"}`,
    ...(["retention_1", "retention_7", "retention_30"] as const).map((step, index) => {
      const cohort = cohorts[index]!;
      return `${[1, 7, 30][index]}일 유지 (${cohort.to} 인사): ${share(sum(cohort.totals, step), sum(cohort.totals, "greeting_sent"))} · 이전 집단 ${share(sum(cohort.previous, step), sum(cohort.previous, "greeting_sent"))}`;
    }),
    ...(
      [
        ["persona", "페르소나"],
        ["operator", "운영자"],
        ["user", "사용자"],
      ] as const
    ).map(
      ([initiator, label]) =>
        `종료·${label}: ${compare(ending(daily, initiator), ending(daily, initiator, true), ending(weekly, initiator), ending(weekly, initiator, true))}`,
    ),
    `AI 비용(USD): ${compare(cost(daily), cost(daily, true), cost(weekly), cost(weekly, true))}`,
    `운영 알림: ${
      daily.alerts
        .map((alert) => alert.name)
        .join(", ")
        .slice(0, 120) || "없음"
    }`,
    "https://admin.renai.im/metrics",
  ].join("\n");
};

export const dailyReport = (load: (query: MetricsQuery) => Promise<Metrics>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    const [row] = yield* sql<{
      due: number;
    }>`SELECT due FROM metrics_report WHERE id = 1 AND due <= ${now}`;
    if (!row) return;
    const to = koreaDay(row.due - 86_400_000);
    const [daily, weekly, ...cohorts] = yield* Effect.tryPromise(() =>
      Promise.all([
        load({ from: to, to, breakdown: "source" }),
        load({ from: koreaDay(row.due - 7 * 86_400_000), to }),
        ...[1, 7, 30].map((days) => {
          const cohort = koreaDay(row.due - (days + 1) * 86_400_000);
          return load({ from: cohort, to: cohort });
        }),
      ]),
    );
    yield* Effect.gen(function* () {
      const claimed =
        yield* sql`UPDATE metrics_report SET due = ${row.due + 86_400_000} WHERE id = 1 AND due = ${row.due} RETURNING id`;
      if (!claimed.length) return;
      yield* queueDiscord(`report:${to}`, "reports", reportText(daily, weekly, cohorts));
      yield* sql`INSERT INTO application_work(name, due) VALUES ('metrics-report', ${row.due + 86_400_000}) ON CONFLICT(name) DO UPDATE SET due = excluded.due, generation = generation + 1`;
    }).pipe(sql.withTransaction);
  });
