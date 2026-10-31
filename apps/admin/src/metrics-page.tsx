import type { Metrics, MetricTotal, MetricsQuery } from "@ren-ai/onboarding";

const steps: ReadonlyArray<readonly [MetricTotal["step"], string]> = [
  ["visit", "방문"],
  ["explore", "둘러보기"],
  ["profile_seen", "프로필 노출"],
  ["profile_opened", "프로필 열기"],
  ["first_like", "Like한 방문"],
  ["join_opened", "등록 양식"],
  ["join", "등록"],
  ["selection", "선정"],
  ["greeting_sent", "첫 인사 전송"],
  ["first_reply", "첫 답장"],
  ["active", "활성 사용자"],
  ["retention_1", "1일 유지"],
  ["retention_7", "7일 유지"],
  ["retention_30", "30일 유지"],
  ["greeting_failed", "인사 실패"],
  ["greeting_uncertain", "인사 결과 불확실"],
  ["join_failed", "등록 실패"],
  ["ending", "관계 종료"],
];
const dimensions = [
  ["total", "전체"],
  ["source", "방문 경로"],
  ["country", "국가"],
  ["device", "기기"],
  ["locale", "화면 언어"],
  ["imageStyle", "이미지 스타일"],
  ["persona", "페르소나"],
  ["relationship", "시작 관계"],
  ["language", "대화 언어"],
  ["joining", "첫 등록·재선택"],
  ["reason", "실패 이유"],
  ["initiator", "종료 주체"],
] as const;
const sum = (rows: readonly MetricTotal[], step: MetricTotal["step"]) =>
  rows.filter((row) => row.step === step).reduce((total, row) => total + row.count, 0);
const rate = (numerator: number, denominator: number) =>
  denominator ? `${((100 * numerator) / denominator).toFixed(1)}%` : "—";
const change = (now: number, before: number) =>
  `${now - before >= 0 ? "+" : ""}${now - before} (${rate(now - before, before)})`;
const stateLabels = { unconfigured: "미설정", accepting: "수신 중", rejected: "거부됨" };
const comparison = (now: number, before: number) => `${now} / ${before}`;
const previousDay = (metrics: Metrics, day: string) =>
  new Date(Date.parse(day) - (Date.parse(metrics.from) - Date.parse(metrics.previousFrom)))
    .toISOString()
    .slice(0, 10);
const currentDay = (metrics: Metrics, day: string) =>
  new Date(Date.parse(day) + Date.parse(metrics.from) - Date.parse(metrics.previousFrom))
    .toISOString()
    .slice(0, 10);

const rowKey = (row: MetricTotal) => JSON.stringify([row.day, row.step, row.dimension, row.value]);
const costDays = (metrics: Metrics) =>
  [
    ...new Set([
      ...metrics.cost.map((row) => row.day),
      ...metrics.previousCost.map((row) => currentDay(metrics, row.day)),
    ]),
  ].toSorted();

function comparisonRows(metrics: Metrics) {
  const rows = new Map(
    metrics.previous.map((prior) => {
      const row = { ...prior, day: currentDay(metrics, prior.day), count: 0 };
      return [rowKey(row), row] as const;
    }),
  );
  for (const row of metrics.totals) rows.set(rowKey(row), row);
  return [...rows.values()];
}

function Chart({ metrics }: { metrics: Metrics }) {
  const days: string[] = [];
  for (let at = Date.parse(metrics.from); at <= Date.parse(metrics.to); at += 86_400_000)
    days.push(new Date(at).toISOString().slice(0, 10));
  const series = (["visit", "join"] as const).map((step) =>
    days.map((day) =>
      sum(
        metrics.totals.filter((row) => row.dimension === "total" && row.day === day),
        step,
      ),
    ),
  );
  const max = Math.max(1, ...series.flat());
  return (
    <figure>
      <figcaption>일별 방문(파랑) · 등록(분홍), 한국 시간</figcaption>
      <svg viewBox="0 0 720 180" aria-label={`${metrics.from}부터 ${metrics.to}까지 방문과 등록`}>
        {series.map((values, index) => (
          <polyline
            key={index}
            fill="none"
            stroke={index ? "#c72c52" : "#2463a8"}
            strokeWidth="3"
            points={values
              .map(
                (value, day) =>
                  `${10 + (day * 700) / Math.max(1, days.length - 1)},${170 - (value * 160) / max}`,
              )
              .join(" ")}
          />
        ))}
      </svg>
    </figure>
  );
}

export function MetricsPage({ metrics, query }: { metrics?: Metrics; query: MetricsQuery }) {
  const compared = metrics ? comparisonRows(metrics) : [];
  const totals = compared.filter((row) => row.dimension === "total");
  const previous = metrics?.previous.filter((row) => row.dimension === "total") ?? [];
  const cost = metrics?.cost.reduce((total, row) => total + row.cost, 0) ?? 0;
  return (
    <section>
      <h1>지표</h1>
      <p>RenAI · 한국 시간(UTC+9) · 익명 합계</p>
      <nav aria-label="기간">
        {[
          ["today", "오늘"],
          ["yesterday", "어제"],
          ["7", "최근 7일"],
          ["30", "최근 30일"],
        ].map(([period, label]) => (
          <a key={period} href={`/metrics?period=${period}`}>
            {label}{" "}
          </a>
        ))}
      </nav>
      <form method="get">
        <label>
          시작일 <input type="date" name="from" defaultValue={query.from} required />
        </label>
        <label>
          종료일 <input type="date" name="to" defaultValue={query.to} required />
        </label>
        <label>
          분류{" "}
          <select name="breakdown" defaultValue={query.breakdown ?? "total"}>
            {dimensions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">조회</button>
      </form>
      <a href="https://renai.im/explore?metrics=off">이 브라우저를 집계에서 제외</a>
      {metrics && (
        <>
          <p>
            {metrics.from} — {metrics.to} · 비교: {metrics.previousFrom} — {metrics.previousTo}
          </p>
          <p>
            등록률: {rate(sum(totals, "join"), sum(totals, "visit"))} · 이전:{" "}
            {rate(sum(previous, "join"), sum(previous, "visit"))}
          </p>
          <Chart metrics={metrics} />
          <table>
            <caption>여정과 이전 기간 비교</caption>
            <thead>
              <tr>
                <th>단계</th>
                <th>합계</th>
                <th>이전</th>
                <th>변화</th>
                <th>이전 단계 대비</th>
              </tr>
            </thead>
            <tbody>
              {steps.map(([step, label], index) => {
                const count = sum(totals, step),
                  before = sum(previous, step);
                return (
                  <tr key={step}>
                    <th>{label}</th>
                    <td>{count}</td>
                    <td>{before}</td>
                    <td>{change(count, before)}</td>
                    <td>
                      {index > 0 && index < 10
                        ? rate(count, sum(totals, steps[index - 1]![0]))
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {query.breakdown && query.breakdown !== "total" && (
            <table>
              <caption>분류별 합계 · 이전 기간 비교</caption>
              <thead>
                <tr>
                  <th>일자</th>
                  <th>단계</th>
                  <th>분류</th>
                  <th>합계</th>
                  <th>이전</th>
                </tr>
              </thead>
              <tbody>
                {compared
                  .filter((row) => row.dimension === query.breakdown)
                  .map((row) => (
                    <tr key={`${row.day}:${row.step}:${row.value}`}>
                      <td>{row.day}</td>
                      <td>{steps.find(([step]) => step === row.step)?.[1] ?? row.step}</td>
                      <td>{row.value}</td>
                      <td>{row.count}</td>
                      <td>
                        {metrics.previous.find(
                          (prior) =>
                            prior.day === previousDay(metrics, row.day) &&
                            prior.step === row.step &&
                            prior.dimension === row.dimension &&
                            prior.value === row.value,
                        )?.count ?? 0}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
          <table>
            <caption>페르소나 · 현재 / 이전</caption>
            <thead>
              <tr>
                <th>페르소나</th>
                <th>Like</th>
                <th>Like 비율</th>
                <th>배정</th>
                <th>첫 답장</th>
                <th>1일 / 7일 / 30일 유지</th>
                <th>종료</th>
              </tr>
            </thead>
            <tbody>
              {[
                ...new Set(
                  [...metrics.personas, ...metrics.previousPersonas].map((row) => row.value),
                ),
              ].map((id) => {
                const rows = metrics.personas.filter((row) => row.value === id);
                const before = metrics.previousPersonas.filter((row) => row.value === id);
                return (
                  <tr key={id}>
                    <th>{id}</th>
                    <td>{comparison(sum(rows, "like"), sum(before, "like"))}</td>
                    <td>
                      {rate(sum(rows, "like"), sum(rows, "like") + sum(rows, "pass"))} /{" "}
                      {rate(sum(before, "like"), sum(before, "like") + sum(before, "pass"))}
                    </td>
                    <td>{comparison(sum(rows, "selection"), sum(before, "selection"))}</td>
                    <td>{comparison(sum(rows, "first_reply"), sum(before, "first_reply"))}</td>
                    <td>
                      {(["retention_1", "retention_7", "retention_30"] as const)
                        .map(
                          (step) =>
                            `${rate(sum(rows, step), sum(rows, "greeting_sent"))} / ${rate(sum(before, step), sum(before, "greeting_sent"))}`,
                        )
                        .join(" · ")}
                    </td>
                    <td>{comparison(sum(rows, "ending"), sum(before, "ending"))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <table>
            <caption>첫 인사 날짜별 유지율 · 1일 / 7일 / 30일</caption>
            <thead>
              <tr>
                <th>첫 인사 날짜</th>
                <th>인사 전송</th>
                <th>유지율 (현재 / 이전 집단)</th>
              </tr>
            </thead>
            <tbody>
              {totals
                .filter((row) => row.step === "greeting_sent")
                .map((row) => {
                  const cohort = totals.filter((value) => value.day === row.day);
                  const before = previous.filter(
                    (value) => value.day === previousDay(metrics, row.day),
                  );
                  return (
                    <tr key={row.day}>
                      <th>{row.day}</th>
                      <td>{comparison(row.count, sum(before, "greeting_sent"))}</td>
                      <td>
                        {(["retention_1", "retention_7", "retention_30"] as const)
                          .map(
                            (step) =>
                              `${rate(sum(cohort, step), row.count)} / ${rate(sum(before, step), sum(before, "greeting_sent"))}`,
                          )
                          .join(" · ")}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          <h2>AI 비용 (USD)</h2>
          <p>
            ${cost.toFixed(4)} · 이전 $
            {metrics.previousCost.reduce((total, row) => total + row.cost, 0).toFixed(4)} · 활성
            사용자·일당 ${sum(totals, "active") ? (cost / sum(totals, "active")).toFixed(4) : "—"}
            {" · 이전 $"}
            {sum(previous, "active")
              ? (
                  metrics.previousCost.reduce((total, row) => total + row.cost, 0) /
                  sum(previous, "active")
                ).toFixed(4)
              : "—"}
          </p>
          <table>
            <caption>일별 비용 · 현재 / 이전</caption>
            <thead>
              <tr>
                <th>일자</th>
                <th>비용</th>
                <th>대화당</th>
              </tr>
            </thead>
            <tbody>
              {costDays(metrics).map((day) => {
                const row = metrics.cost.find((value) => value.day === day) ?? {
                  day,
                  cost: 0,
                  conversations: 0,
                };
                const before = metrics.previousCost.find(
                  (value) => value.day === previousDay(metrics, row.day),
                );
                return (
                  <tr key={row.day}>
                    <td>{row.day}</td>
                    <td>
                      ${row.cost.toFixed(4)} / ${(before?.cost ?? 0).toFixed(4)}
                    </td>
                    <td>
                      ${row.conversations ? (row.cost / row.conversations).toFixed(4) : "—"} / $
                      {before?.conversations
                        ? (before.cost / before.conversations).toFixed(4)
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <h2>운영 알림 · Discord</h2>
          <p>
            알림: {stateLabels[metrics.delivery.alerts]} · 보고서:{" "}
            {stateLabels[metrics.delivery.reports]} · 전송 대기 {metrics.delivery.pending}건
          </p>
          <ul>
            {metrics.alerts.map((alert) => (
              <li key={alert.name}>
                <a href={alert.url}>{alert.name}</a> · {alert.detail} ·{" "}
                {new Date(alert.raisedAt).toISOString()}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
