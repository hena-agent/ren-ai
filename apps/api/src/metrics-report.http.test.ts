import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, expect, test, vi } from "vitest";
import { koreaDay } from "@ren-ai/onboarding";
import {
  metricsFixture as fixture,
  activityRequest as request,
  visitActivity as report,
  visitSource as source,
} from "../test/metrics-http.test-helper.ts";
import { discordPost } from "../test/discord.test-helper.ts";
import { changeAlert } from "./metrics/alerts.ts";

afterEach(() => vi.restoreAllMocks());

const spend = (store: Awaited<ReturnType<typeof fixture>>["store"], id: string, cost: number) =>
  store.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT OR IGNORE INTO usage_session(session_id, conversation_id, conversation_key, persona_id) VALUES ('historical', 0, 'anonymous', 'sora')`;
      yield* sql`INSERT INTO usage_entry(id, session_id, source, started_at, outcome, cost) VALUES (${id}, 'historical', 'message', ${Date.now()}, 'succeeded', ${cost})`;
    }),
  );

test("a Report card sections traffic, first conversations, retention and cost with daily and weekly changes", async () => {
  const f = await fixture();
  try {
    await f.browser(request(report));
    await f.browser(request(report));
    await f.browser(request({ ...report, source: { ...source, campaign: "second" } }));
    await f.register("+821012345678", { source });
    await spend(f.store, "historical", 1);
    await f.store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO metric_total(day, step, dimension, value, count) VALUES (${f.day}, 'ending', 'initiator', 'operator', 1)`;
      }),
    );
    await f.store.metricsTick("first-report");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 86_400_000);
    await Promise.all([f.store.metricsTick("next-report-a"), f.store.metricsTick("next-report-b")]);
    const posts = await Promise.all(f.fetcher.mock.calls.map((call) => discordPost(...call)));
    expect(posts).toHaveLength(2);
    const post = posts[1]!;
    expect(post).toMatchObject({
      sender: "Ren AI 지표",
      accent: 0xc72c52,
      links: [{ label: "지표", url: "https://admin.renai.im/metrics" }],
    });
    expect(post.text).toMatch(
      /^## 📊 Ren AI 일일 보고서\n-# \d{1,2}월 \d{1,2}일 \([일월화수목금토]\) · 한국 시간 · 괄호 안은 전일·이전 7일 대비 증감\n/,
    );
    expect(post.text).toContain(
      [
        "### 유입",
        "**방문** 3 (▲3) · 7일 3 (▲3)",
        "**등록** 1 (▲1) · 7일 1 (▲1)",
        "**등록률** 33.3% · 7일 33.3%",
        "**최대 이탈** 방문 → 둘러보기 · 3건",
        "**주요 경로**",
        "1. example.org · friends/social/launch · 홈 — 2",
        "2. example.org · friends/social/second · 홈 — 1",
        "### 첫 대화",
        "**선정** 0 · 7일 0",
        "**첫 인사 전송** 0 · 7일 0",
        "**인사 실패** 0 · 7일 0",
        "**인사 결과 불확실** 0 · 7일 0",
        "**첫 답장** 0 · 7일 0",
        "**활성 사용자** 0 · 7일 0",
        "### 유지 · 종료 · 비용",
        "**유지율** 1일 — · 7일 — · 30일 —",
      ].join("\n"),
    );
    expect(post.text).toMatch(
      /\n-# 첫 인사 \d{1,2}\/\d{1,2} · \d{1,2}\/\d{1,2} · \d{1,2}\/\d{1,2} 집단 기준, 괄호 안은 하루 전 집단 대비\n/,
    );
    expect(post.text).toContain(
      [
        "**관계 종료** 페르소나 0 · 운영자 1 (▲1) · 사용자 0",
        "-# 7일 페르소나 0 · 운영자 1 (▲1) · 사용자 0",
        "**AI 비용** $1.00 (▲$1.00) · 7일 $1.00 (▲$1.00)",
        "✅ 진행 중인 운영 알림 없음",
      ].join("\n"),
    );
    expect(post.text.length).toBeLessThanOrEqual(4000);
    expect(post.parts).toBeLessThanOrEqual(40);
  } finally {
    await f.close();
  }
});

const count = (
  store: Awaited<ReturnType<typeof fixture>>["store"],
  rows: readonly (readonly [day: string, step: string, count: number])[],
) =>
  store.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const [day, step, total] of rows)
        yield* sql`INSERT INTO metric_total(day, step, dimension, value, count) VALUES (${day}, ${step}, 'total', '', ${total})`;
    }),
  );

test("a Report shows declines, unchanged values, sub-cent cost and ongoing Alerts grouped by title", async () => {
  const f = await fixture();
  try {
    const start = Date.now();
    const day = (offset: number) => koreaDay(start + offset * 86_400_000);
    for (let index = 0; index < 6; index++) await f.browser(request(report));
    await f.register("+821012345678", { source });
    await f.register("+821012345679", { source });
    await spend(f.store, "first-day", 1);
    await count(f.store, [
      [day(0), "selection", 2],
      [day(1), "selection", 2],
      // Retention groups: the first day's Greetings, and the day before's.
      [day(0), "greeting_sent", 2],
      [day(0), "retention_1", 1],
      [day(-1), "greeting_sent", 4],
      [day(-1), "retention_1", 4],
      [day(-7), "greeting_sent", 2],
      [day(-7), "retention_7", 1],
    ]);
    await f.store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO metric_total(day, step, dimension, value, count) VALUES (${f.day}, 'ending', 'initiator', 'operator', 1)`;
        yield* changeAlert("greeting:a", true).pipe(
          Effect.andThen(changeAlert("disk-nearly-full", true)),
          Effect.andThen(changeAlert("greeting:b", true)),
          sql.withTransaction,
        );
      }),
    );
    vi.spyOn(Date, "now").mockReturnValue(start + 86_400_000);
    for (let index = 0; index < 3; index++) await f.browser(request(report));
    await f.register("+821012345670", { source });
    await spend(f.store, "second-day", 0.004);
    vi.spyOn(Date, "now").mockReturnValue(start + 2 * 86_400_000);
    // Each wake queues one missed Report: the day before, the first day, then the second.
    for (const missed of ["before", "first", "second"])
      await f.store.metricsTick(`report-${missed}`);
    const posts = await Promise.all(f.fetcher.mock.calls.map((call) => discordPost(...call)));
    const { text } = posts.findLast((post) => post.sender === "Ren AI 지표")!;
    expect(text).toContain("**방문** 3 (▼3) · 7일 9 (▲9)");
    expect(text).toContain("**등록** 1 (▼1) · 7일 3 (▲3)");
    expect(text).toContain("**등록률** 33.3% · 7일 33.3%");
    expect(text).toContain("**선정** 2 · 7일 4 (▲4)");
    expect(text).toContain("**유지율** 1일 50.0% (▼50.0%p) · 7일 — (이전 50.0%) · 30일 —");
    expect(text).toContain("**관계 종료** 페르소나 0 · 운영자 0 (▼1) · 사용자 0");
    expect(text).toContain("**AI 비용** <$0.01 (▼$1.00) · 7일 $1.00 (▲$1.00)");
    expect(text).toContain("🔴 진행 중인 운영 알림 3건 · 첫 인사 실패 2 · 실행 서버 디스크 부족 1");
  } finally {
    await f.close();
  }
});

/** The longest stored Source value, made of characters whose Discord escaping doubles them. */
const longest = (fill: string) =>
  JSON.stringify([
    "reselection",
    "-".repeat(253),
    ...Array.from({ length: 3 }, () => fill.repeat(80)),
  ]);

/** Answers the Report's Source breakdown from the separate activity store with these Visits. */
const visitsBySource = (
  f: Awaited<ReturnType<typeof fixture>>,
  visits: readonly (readonly [value: string, count: number])[],
) =>
  f.activity.mockImplementation(async (activity) => {
    const query = new URL(activity.url).searchParams;
    return query.get("breakdown") === "source"
      ? Response.json(
          visits.map(([value, total]) => ({
            day: query.get("from"),
            step: "visit",
            dimension: "source",
            value,
            count: total,
          })),
        )
      : f.browser(activity);
  });

test("the largest possible Report still fits one Discord message", async () => {
  const f = await fixture();
  try {
    visitsBySource(
      f,
      ["_", "-", "."].map((fill, index) => [longest(fill), 1_000_000_000 + index] as const),
    );
    await f.store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // A full hour of registration Notifications keeps the Notification cap Alert raised.
        yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
          INSERT INTO notification_attempt(at) SELECT ${Date.now()} FROM n`;
        yield* Effect.forEach(
          [
            "executor-unavailable",
            "messaging-unavailable",
            "screen-locked",
            "disk-nearly-full",
            "provider-failing",
            "go-cap",
            "conversation-turn-failing:ses_1",
            "unexpected-tool",
            "greeting:a",
            "greeting:b",
            "joins-failing",
            "notification-cap",
            "x".repeat(160),
          ],
          (name) => changeAlert(name, true),
        ).pipe(sql.withTransaction);
      }),
    );
    // Four messages per wake: twelve Alerts, then the thirteenth with the Report.
    for (let wake = 0; wake < 4; wake++) await f.store.metricsTick(`largest-${wake}`);
    const posts = await Promise.all(f.fetcher.mock.calls.map((call) => discordPost(...call)));
    expect(posts).toHaveLength(14);
    const largest = posts.find((post) => post.sender === "Ren AI 지표")!;
    expect(largest.text).toContain("🔴 진행 중인 운영 알림 13건 · 첫 인사 실패 2 · ");
    expect(largest.text).toContain("1. \\-\\-\\-");
    for (const post of posts) {
      expect(post.text.length).toBeLessThanOrEqual(4000);
      expect(post.parts).toBeLessThanOrEqual(40);
    }
  } finally {
    await f.close();
  }
});

test.each([
  [
    '["home","example.org","friends","social","launch"]',
    "example.org · friends/social/launch · 홈",
  ],
  ['["explore","","summer_sale","",""]', "직접 방문 · summer\\_sale · 둘러보기"],
  ['["profile","t.co","","",""]', "t.co · 공유 프로필"],
  ['["reselection","","","",""]', "직접 방문 · 재선택 링크"],
  [`["home","${"a".repeat(70)}.com","","",""]`, `${"a".repeat(59)}…`],
  ["other", "기타 경로"],
  ["unknown", "경로 정보 없음"],
])("the Report names the Source %s as %s", async (value, label) => {
  const f = await fixture();
  try {
    visitsBySource(f, [[value, 1]]);
    await f.store.metricsTick("named-source");
    const { text } = await discordPost(...f.fetcher.mock.lastCall!);
    expect(text).toContain(`**주요 경로**\n1. ${label} — 1\n`);
  } finally {
    await f.close();
  }
});
