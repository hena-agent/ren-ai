import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test, vi } from "vitest";
import { alertRequests, applicationAlerts } from "./alerts.ts";
import { deliverDiscord } from "./metrics/discord.ts";
import { migrate } from "./database.ts";
import type { ApplicationStore } from "./application-store.ts";
import { discordPost } from "../test/discord.test-helper.ts";

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.scoped(migrate.pipe(Effect.andThen(effect))).pipe(
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  );

test("alerts are durable, deduplicated and never forward private detail", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("received"));
  await run(
    Effect.gen(function* () {
      const flush = deliverDiscord(
        { alerts: "https://hook.example", reports: undefined },
        fetcher,
        crypto.randomUUID(),
      );
      const alerts = yield* applicationAlerts;
      yield* alerts.raise("bad name", "private prompt");
      yield* alerts.raise("provider-failing", "private prompt");
      yield* alerts.raise("provider-failing");
      yield* alerts.clear("missing");
      yield* flush;
      const restarted = yield* applicationAlerts;
      yield* restarted.raise("provider-failing");
      yield* restarted.clear("provider-failing");
      yield* restarted.clear("provider-failing");
      yield* flush;
    }),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain("private prompt");
  const [raised, cleared] = await Promise.all(
    fetcher.mock.calls.map((call) => discordPost(...call)),
  );
  expect(raised).toMatchObject({
    url: "https://hook.example/?wait=true&with_components=true",
    sender: "Ren AI 알림",
    avatar: "https://renai.im/apple-touch-icon.png",
    accent: 0xed4245,
    links: [{ label: "대화 상태", url: "https://admin.renai.im/conversations" }],
  });
  expect(raised!.text).toContain("### 🔴 AI 응답 실패 지속");
  expect(cleared).toMatchObject({ accent: 0x57f287, links: [] });
  expect(cleared!.text).toContain("### ✅ 해제 · AI 응답 실패 지속");
});

test.each([
  ["executor-unavailable", "대화 실행 서버 응답 없음", "대화 상태", "conversations"],
  ["messaging-unavailable", "iMessage 연결 끊김", "대화 상태", "conversations"],
  ["screen-locked", "Messages Mac 화면 잠김", "대화 상태", "conversations"],
  ["disk-nearly-full", "실행 서버 디스크 부족", "대화 상태", "conversations"],
  ["provider-failing", "AI 응답 실패 지속", "대화 상태", "conversations"],
  ["go-cap", "OpenCode Go 사용 한도 도달", "대화 상태", "conversations"],
  ["conversation-turn-failing:ses_1", "대화 응답 실패", "대화 상태", "conversations"],
  ["unexpected-tool", "허용되지 않은 도구 감지", "대화 상태", "conversations"],
  ["greeting:registration-1", "첫 인사 실패", "첫 연락", "first-contacts"],
  ["joins-failing", "대기자 등록 실패 반복", "대기자", "waitlist"],
  ["notification-cap", "등록 안내 한도 도달", "대기자", "waitlist"],
  ["constructor", "운영 확인 필요", "대화 상태", "conversations"],
])("the %s Alert is a titled card linking to its Admin page", async (name, title, label, path) => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null));
  await run(
    Effect.gen(function* () {
      const health = yield* applicationAlerts;
      const flush = deliverDiscord(
        { alerts: "https://hook.example", reports: undefined },
        fetcher,
        crypto.randomUUID(),
      );
      yield* health.raise(name);
      yield* flush;
      yield* health.clear(name);
      yield* flush;
    }),
  );
  const [raised, cleared] = await Promise.all(
    fetcher.mock.calls.map((call) => discordPost(...call)),
  );
  expect(raised!.text.startsWith(`### 🔴 ${title}\n`)).toBe(true);
  expect(raised!.links).toEqual([{ label, url: `https://admin.renai.im/${path}` }]);
  expect(cleared!.text.startsWith(`### ✅ 해제 · ${title}\n`)).toBe(true);
});

test("a cleared Alert shows when it began and ended, and how long it lasted when its start is known", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null));
  await run(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-28T06:02:00Z"));
      const health = yield* applicationAlerts;
      const flush = deliverDiscord(
        { alerts: "https://hook.example", reports: undefined },
        fetcher,
        crypto.randomUUID(),
      );
      for (const lasted of [20_000, 7_500_000, 86_820_000]) {
        yield* health.raise("screen-locked");
        yield* flush;
        yield* TestClock.adjust(lasted);
        yield* health.clear("screen-locked");
        yield* flush;
      }
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO application_alert(name) VALUES ('disk-nearly-full')`;
      yield* health.clear("disk-nearly-full");
      yield* flush;
    }).pipe(Effect.provide(TestClock.layer())),
  );
  const posts = await Promise.all(fetcher.mock.calls.map((call) => discordPost(...call)));
  expect(posts.map((post) => post.text)).toEqual([
    "### 🔴 Messages Mac 화면 잠김\n메시징 화면이 잠겨 있습니다.\n-# `screen-locked` · <t:1793167320:f> 발생",
    "### ✅ 해제 · Messages Mac 화면 잠김\n20초 만에 해제되었습니다.\n-# `screen-locked` · <t:1793167320:f> 발생 · <t:1793167340:f> 해제",
    "### 🔴 Messages Mac 화면 잠김\n메시징 화면이 잠겨 있습니다.\n-# `screen-locked` · <t:1793167340:f> 발생",
    "### ✅ 해제 · Messages Mac 화면 잠김\n2시간 5분 만에 해제되었습니다.\n-# `screen-locked` · <t:1793167340:f> 발생 · <t:1793174840:f> 해제",
    "### 🔴 Messages Mac 화면 잠김\n메시징 화면이 잠겨 있습니다.\n-# `screen-locked` · <t:1793174840:f> 발생",
    "### ✅ 해제 · Messages Mac 화면 잠김\n1일 7분 만에 해제되었습니다.\n-# `screen-locked` · <t:1793174840:f> 발생 · <t:1793261660:f> 해제",
    "### ✅ 해제 · 실행 서버 디스크 부족\n-# `disk-nearly-full` · <t:1793261660:f> 해제",
  ]);
});

test("rejected and failed alert deliveries log safe diagnostics and stay queued for retry", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockRejectedValueOnce("private failure input");
  try {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const alerts = yield* applicationAlerts;
        yield* alerts.raise("executor-unavailable");
        yield* alerts.raise("disk-nearly-full");
        yield* deliverDiscord(
          { alerts: "https://hook.example/private-token", reports: undefined },
          fetcher,
          crypto.randomUUID(),
        );
        expect(yield* sql`SELECT attempts FROM discord_outbox`).toEqual([
          { attempts: 1 },
          { attempts: 1 },
        ]);
      }),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    const logs = JSON.stringify(stderr.mock.calls);
    expect(logs).toContain("discord.delivery");
    expect(logs).toContain("DISCORD_HTTP");
    expect(logs).toContain('\\"upstreamStatus\\":401');
    expect(logs).not.toContain("private failure input");
    expect(logs).not.toContain("private-token");
  } finally {
    stderr.mockRestore();
  }
});

const changes = (alerts: readonly { name: string; raised: boolean }[]) =>
  JSON.stringify({ alerts });

test("monitor reports authenticate, reject malformed changes and commit every change together", async () => {
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const context = yield* Effect.context<SqlClient.SqlClient>();
      const store = fromPartial<ApplicationStore>({
        run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
          Effect.runPromise(Effect.provide(effect, context)),
      });
      const handler = alertRequests(store, "management-secret");
      const report = (body: string, authorization = "Bearer management-secret", method = "POST") =>
        Effect.promise(() =>
          handler(
            new Request("https://app/management/alerts", {
              method,
              headers: { authorization },
              ...(method === "POST" && { body }),
            }),
          ),
        );
      expect((yield* report(changes([]), "Bearer wrong")).status).toBe(401);
      const rejected = yield* report("", "Bearer management-secret", "GET");
      expect(rejected.status).toBe(405);
      expect(rejected.headers.get("Allow")).toBe("POST");
      for (const malformed of ["{", JSON.stringify({ alerts: [{ name: "x", raised: "yes" }] })])
        expect((yield* report(malformed)).status).toBe(400);
      const raised = [
        { name: "executor-unavailable", raised: true },
        { name: "disk-nearly-full", raised: true },
      ];
      expect((yield* report(changes(raised))).status).toBe(204);
      expect((yield* report(changes(raised))).status).toBe(204);
      expect(yield* sql`SELECT name FROM application_alert ORDER BY name`).toEqual([
        { name: "disk-nearly-full" },
        { name: "executor-unavailable" },
      ]);
      expect(yield* sql`SELECT COUNT(*) AS queued FROM discord_outbox`).toEqual([{ queued: 2 }]);
      expect(
        (yield* report(changes([{ name: "executor-unavailable", raised: false }]))).status,
      ).toBe(204);
      expect(yield* sql`SELECT name FROM application_alert`).toEqual([
        { name: "disk-nearly-full" },
      ]);
    }),
  );
});
