import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { koreaDay, type Metrics, type MetricTotal, type MetricsQuery } from "@ren-ai/onboarding";
import { queueDiscord } from "./discord.ts";
import { accents, card, divider, escapeMarkdown, linkRow, text } from "./discord-message.ts";
import { alertTitle } from "./alerts.ts";
import { sourceLabel } from "./totals.ts";

type Step = MetricTotal["step"];
const sum = (rows: readonly MetricTotal[], step: Step) =>
  rows
    .filter((row) => row.dimension === "total" && row.step === step)
    .reduce((value, row) => value + row.count, 0);

const labels = {
  visit: "방문",
  explore: "둘러보기",
  first_like: "첫 Like",
  join_opened: "등록 양식",
  join: "등록",
  selection: "선정",
  greeting_sent: "첫 인사 전송",
  greeting_failed: "인사 실패",
  greeting_uncertain: "인사 결과 불확실",
  first_reply: "첫 답장",
  active: "활성 사용자",
} satisfies Partial<Record<Step, string>>;
type LabelledStep = keyof typeof labels;

const counts = new Intl.NumberFormat("ko-KR");
const formatCount = (value: number) => counts.format(value);
/** A change in parentheses, omitted when nothing changed. */
const change = (delta: number, format: (value: number) => string) =>
  delta > 0 ? ` (▲${format(delta)})` : delta < 0 ? ` (▼${format(-delta)})` : "";
const countWithChange = (now: number, before: number) =>
  `${formatCount(now)}${change(now - before, formatCount)}`;

/** A share in tenths of a percent, so a displayed rate and its change agree. */
const tenths = (part: number, whole: number) =>
  whole ? Math.round((part / whole) * 1000) : undefined;
const percent = (value: number) => `${(value / 10).toFixed(1)}%`;
const rateWithChange = (now: number | undefined, before: number | undefined) => {
  if (now === undefined) return before === undefined ? "—" : `— (이전 ${percent(before)})`;
  return `${percent(now)}${before === undefined ? "" : change(now - before, (delta) => `${percent(delta)}p`)}`;
};

const cents = (value: number) => Math.round(value * 100);
const dollars = (value: number) => `$${(value / 100).toFixed(2)}`;
const costWithChange = (now: number, before: number) =>
  `${now > 0 && !cents(now) ? "<$0.01" : dollars(cents(now))}${change(cents(now) - cents(before), dollars)}`;
const totalCost = (rows: Metrics["cost"]) => rows.reduce((total, row) => total + row.cost, 0);

const reportDate = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
  weekday: "short",
  timeZone: "UTC",
});
const shortDate = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8))}`;

/** One line comparing the day with the day before, then the week with the week before. */
const dayAndWeek = (
  label: string,
  daily: Metrics,
  weekly: Metrics,
  format: (period: Metrics) => string,
) => `**${label}** ${format(daily)} · 7일 ${format(weekly)}`;
const stepLine = (daily: Metrics, weekly: Metrics, step: LabelledStep) =>
  dayAndWeek(labels[step], daily, weekly, (period) =>
    countWithChange(sum(period.totals, step), sum(period.previous, step)),
  );
const joinRate = (period: Metrics) =>
  rateWithChange(
    tenths(sum(period.totals, "join"), sum(period.totals, "visit")),
    tenths(sum(period.previous, "join"), sum(period.previous, "visit")),
  );
const periodCost = (period: Metrics) =>
  costWithChange(totalCost(period.cost), totalCost(period.previousCost));

const funnel = [
  "visit",
  "explore",
  "first_like",
  "join_opened",
  "join",
  "selection",
  "greeting_sent",
  "first_reply",
] as const satisfies readonly LabelledStep[];
const biggestDrop = (daily: Metrics) => {
  const [drop] = funnel
    .slice(1)
    .map((step, index) => ({
      from: funnel[index]!,
      step,
      lost: sum(daily.totals, funnel[index]!) - sum(daily.totals, step),
    }))
    .toSorted((a, b) => b.lost - a.lost);
  return `**최대 이탈** ${drop!.lost > 0 ? `${labels[drop!.from]} → ${labels[drop!.step]} · ${formatCount(drop!.lost)}건` : "없음"}`;
};

const topSources = (daily: Metrics) => {
  const top = daily.totals
    .filter((row) => row.dimension === "source" && row.step === "visit")
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 3);
  if (!top.length) return ["**주요 경로** 없음"];
  return [
    "**주요 경로**",
    ...top.map((row, index) => {
      const label = sourceLabel(row.value);
      const shown = escapeMarkdown(label.length > 60 ? `${label.slice(0, 59)}…` : label);
      return `${index + 1}. ${shown} — ${formatCount(row.count)}`;
    }),
  ];
};

const retention = (cohorts: readonly Metrics[]) => [
  `**유지율** ${(["retention_1", "retention_7", "retention_30"] as const)
    .map((step, index) => {
      const cohort = cohorts[index]!;
      return `${[1, 7, 30][index]}일 ${rateWithChange(
        tenths(sum(cohort.totals, step), sum(cohort.totals, "greeting_sent")),
        tenths(sum(cohort.previous, step), sum(cohort.previous, "greeting_sent")),
      )}`;
    })
    .join(" · ")}`,
  `-# 첫 인사 ${cohorts.map((cohort) => shortDate(cohort.to)).join(" · ")} 집단 기준, 괄호 안은 하루 전 집단 대비`,
];

const endedBy = (rows: readonly MetricTotal[], initiator: string) =>
  rows.filter((row) => row.value === initiator).reduce((total, row) => total + row.count, 0);
const endingCounts = (period: Metrics) =>
  (
    [
      ["persona", "페르소나"],
      ["operator", "운영자"],
      ["user", "사용자"],
    ] as const
  )
    .map(
      ([initiator, label]) =>
        `${label} ${countWithChange(endedBy(period.endings, initiator), endedBy(period.previousEndings, initiator))}`,
    )
    .join(" · ");

const ongoingAlerts = (alerts: Metrics["alerts"]) => {
  if (!alerts.length) return "✅ 진행 중인 운영 알림 없음";
  const titles = new Map<string, number>();
  for (const { name } of alerts)
    titles.set(alertTitle(name), (titles.get(alertTitle(name)) ?? 0) + 1);
  const grouped = [...titles]
    .toSorted((a, b) => b[1] - a[1])
    .map(([title, total]) => `${title} ${formatCount(total)}`);
  return `🔴 진행 중인 운영 알림 ${formatCount(alerts.length)}건 · ${grouped.join(" · ")}`;
};

const reportMessage = (daily: Metrics, weekly: Metrics, cohorts: readonly Metrics[]) =>
  card(accents.report, [
    text(
      `## 📊 RenAI 일일 보고서\n-# ${reportDate.format(Date.parse(daily.to))} · 한국 시간 · 괄호 안은 전일·이전 7일 대비 증감`,
    ),
    divider,
    text(
      [
        "### 유입",
        stepLine(daily, weekly, "visit"),
        stepLine(daily, weekly, "join"),
        dayAndWeek("등록률", daily, weekly, joinRate),
        biggestDrop(daily),
        ...topSources(daily),
      ].join("\n"),
    ),
    divider,
    text(
      [
        "### 첫 대화",
        ...(
          [
            "selection",
            "greeting_sent",
            "greeting_failed",
            "greeting_uncertain",
            "first_reply",
            "active",
          ] as const
        ).map((step) => stepLine(daily, weekly, step)),
      ].join("\n"),
    ),
    divider,
    text(
      [
        "### 유지 · 종료 · 비용",
        ...retention(cohorts),
        `**관계 종료** ${endingCounts(daily)}`,
        `-# 7일 ${endingCounts(weekly)}`,
        dayAndWeek("AI 비용", daily, weekly, periodCost),
      ].join("\n"),
    ),
    divider,
    text(ongoingAlerts(daily.alerts)),
    linkRow("지표", "https://admin.renai.im/metrics"),
  ]);

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
      yield* queueDiscord(`report:${to}`, "reports", reportMessage(daily, weekly, cohorts));
      yield* sql`INSERT INTO application_work(name, due) VALUES ('metrics-report', ${row.due + 86_400_000}) ON CONFLICT(name) DO UPDATE SET due = excluded.due, generation = generation + 1`;
    }).pipe(sql.withTransaction);
  });
