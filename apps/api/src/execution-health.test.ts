import { SqliteClient } from "@effect/sql-sqlite-node";
import { Clock, Deferred, Effect, Exit } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { expect, test, vi } from "vitest";
import { createExecutionHealth as executionHealth } from "./execution-health.ts";
import { deliverDiscord } from "./metrics/discord.ts";
import { migrate } from "./database.ts";
import { discordPost } from "../test/discord.test-helper.ts";

const configuration = {
  apiMsgUrl: "https://executor.example",
  openCodeUrl: "https://executor.example/opencode",
  imsgRpcUrl: "https://executor.example/imsg/rpc",
  managementToken: "management-secret",
  model: "test",
  directory: "/srv/ren-ai",
};
const createExecutionHealth = (
  config: typeof configuration,
  webhook: string | undefined,
  fetcher: typeof fetch,
  probe: Effect.Effect<void, Error>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const health = yield* executionHealth(config, fetcher, probe);
    const flush = webhook
      ? deliverDiscord({ alerts: webhook, reports: undefined }, fetcher, crypto.randomUUID()).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        )
      : Effect.void;
    return {
      raise: (name: string, detail?: string) =>
        health.raise(name, detail).pipe(Effect.andThen(flush)),
      clear: (name: string) => health.clear(name).pipe(Effect.andThen(flush)),
      tick: health.tick.pipe(Effect.andThen(flush)),
    };
  });
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
      const health = yield* createExecutionHealth(
        configuration,
        "https://hook.example",
        fetcher,
        Effect.void,
      );
      yield* health.raise("bad name", "private prompt");
      yield* health.raise("provider-failing", "private prompt");
      yield* health.raise("provider-failing");
      yield* health.clear("missing");
      const restarted = yield* createExecutionHealth(
        configuration,
        "https://hook.example",
        fetcher,
        Effect.void,
      );
      yield* restarted.raise("provider-failing");
      yield* restarted.clear("provider-failing");
      yield* restarted.clear("provider-failing");
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
      const health = yield* createExecutionHealth(
        configuration,
        "https://hook.example",
        fetcher,
        Effect.void,
      );
      yield* health.raise(name);
      yield* health.clear(name);
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
      const health = yield* createExecutionHealth(
        configuration,
        "https://hook.example",
        fetcher,
        Effect.void,
      );
      for (const lasted of [20_000, 7_500_000, 86_820_000]) {
        yield* health.raise("screen-locked");
        yield* TestClock.adjust(lasted);
        yield* health.clear("screen-locked");
      }
      const sql = yield* SqlClient.SqlClient;
      // Alerts raised before Metrics shipped have no recorded start.
      yield* sql`INSERT INTO application_alert(name) VALUES ('disk-nearly-full')`;
      yield* health.clear("disk-nearly-full");
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

test("health checks are rate limited and keep native facts separate from credentials", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json(
      {
        service: "api-msg",
        revision: "development",
        status: "degraded",
        diskNearlyFull: true,
        screenLocked: true,
      },
      { status: 503 },
    ),
  );
  await run(
    Effect.gen(function* () {
      const health = yield* createExecutionHealth(configuration, undefined, fetcher, Effect.void);
      yield* health.tick;
      yield* health.tick;
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT name FROM application_alert ORDER BY name`).toEqual([
        { name: "disk-nearly-full" },
        { name: "screen-locked" },
      ]);
      const docker = yield* createExecutionHealth(configuration, undefined, fetcher, Effect.void);
      fetcher.mockResolvedValue(
        Response.json({
          service: "api-msg",
          revision: "development",
          status: "ready",
          diskNearlyFull: false,
          screenLocked: null,
        }),
      );
      yield* docker.tick;
      expect(fetcher).toHaveBeenCalledOnce();
      yield* TestClock.adjust("5 minutes");
      yield* docker.tick;
      expect(yield* sql`SELECT name FROM application_alert`).toEqual([{ name: "screen-locked" }]);
      const restarted = yield* createExecutionHealth(
        configuration,
        undefined,
        fetcher,
        Effect.void,
      );
      fetcher.mockResolvedValue(
        Response.json({
          service: "api-msg",
          revision: "development",
          status: "ready",
          diskNearlyFull: false,
          screenLocked: false,
        }),
      );
      yield* TestClock.adjust("5 minutes");
      yield* restarted.tick;
      expect(yield* sql`SELECT name FROM application_alert`).toEqual([]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[0]![1]?.headers).toEqual({ Authorization: "Bearer management-secret" });
});

test.each([502, 503, 200])(
  "health HTTP %s and notification failures record safe diagnostics before recovery",
  async (status) => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        status === 200
          ? Response.json({ service: "api-msg", revision: "development", status: "degraded" })
          : new Response(null, { status }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockRejectedValueOnce("private failure input");
    try {
      await run(
        Effect.gen(function* () {
          const health = yield* createExecutionHealth(
            configuration,
            "https://hook.example",
            fetcher,
            Effect.void,
          );
          yield* health.tick;
          yield* health.raise("other-alert");
          const sql = yield* SqlClient.SqlClient;
          expect(
            yield* sql`SELECT name FROM application_alert WHERE name = 'executor-unavailable'`,
          ).toHaveLength(1);
        }),
      );
      const logs = JSON.stringify(stderr.mock.calls);
      expect(logs).toContain("executor.health");
      expect(logs).toContain("discord.delivery");
      expect(logs).toContain(`\\"status\\":${status}`);
      expect(logs).not.toContain("management-secret");
      expect(logs).not.toContain("private failure input");
    } finally {
      stderr.mockRestore();
    }
  },
);

test("stalled executor health and alert delivery abort without holding the maintenance tick", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const entered = Deferred.makeUnsafe<void>();
  const signals: AbortSignal[] = [];
  const fetcher: typeof fetch = (_input, init) => {
    signals.push(init!.signal!);
    Effect.runSync(Deferred.succeed(entered, undefined));
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
  };
  try {
    await run(
      Effect.gen(function* () {
        const health = yield* createExecutionHealth(
          configuration,
          "https://hook.example",
          fetcher,
          Effect.void,
        );
        const tick = yield* health.tick.pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("20 seconds");
        const result = tick.pollUnsafe();
        expect(result).toBeDefined();
        if (result) expect(Exit.isSuccess(result)).toBe(true);
        expect(signals).toHaveLength(2);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT name FROM application_alert`).toEqual([
          { name: "executor-unavailable" },
        ]);
      }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
    );
    const logs = JSON.stringify(stderr.mock.calls);
    expect(logs).toContain("executor.health");
    expect(logs).toContain("discord.delivery");
    expect(logs).toContain("TimeoutError");
    expect(logs).toContain("requestId");
    expect(logs).not.toContain("management-secret");
    expect(logs).not.toContain("hook.example");
  } finally {
    stderr.mockRestore();
  }
});

test("APNs failures survive actor replacement, alert after two probes, and clear on recovery", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const fetcher = vi.fn<typeof fetch>(async (input) =>
    new Request(input).url.includes("hook.example")
      ? new Response(null)
      : Response.json({
          service: "api-msg",
          revision: "development",
          status: "ready",
          diskNearlyFull: false,
          screenLocked: false,
        }),
  );
  let failing = true;
  let probes = 0;
  const operationId = crypto.randomUUID();
  const probe = Effect.suspend(() => {
    probes++;
    return failing
      ? Effect.fail(
          Object.assign(new Error("private Apple detail"), {
            code: "APNS_UNAVAILABLE",
            requestId: operationId,
          }),
        )
      : Effect.void;
  });
  try {
    await run(
      Effect.gen(function* () {
        let health = yield* createExecutionHealth(
          configuration,
          "https://hook.example",
          fetcher,
          probe,
        );
        yield* health.tick;
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT name FROM application_alert`).toEqual([]);
        health = yield* createExecutionHealth(
          configuration,
          "https://hook.example",
          fetcher,
          probe,
        );
        yield* health.tick;
        expect(probes).toBe(1);
        yield* TestClock.adjust("20 seconds");
        yield* health.tick;
        expect(yield* sql`SELECT name FROM application_alert`).toEqual([
          { name: "messaging-unavailable" },
        ]);
        yield* TestClock.adjust("20 seconds");
        yield* health.tick;
        expect(
          fetcher.mock.calls.filter(([input]) => new Request(input).url.includes("hook.example")),
        ).toHaveLength(1);
        failing = false;
        yield* TestClock.adjust("20 seconds");
        yield* health.tick;
        expect(yield* sql`SELECT name FROM application_alert`).toEqual([]);
        expect(
          yield* sql`SELECT 1 FROM application_clock WHERE name = 'messaging.failures'`,
        ).toEqual([]);
        const [scheduled] = yield* sql<{
          due: number;
        }>`SELECT due FROM application_work WHERE name = 'messaging-health'`;
        expect(scheduled!.due).toBe((yield* Clock.currentTimeMillis) + 120_000);
        expect(
          fetcher.mock.calls.filter(([input]) => new Request(input).url.includes("hook.example")),
        ).toHaveLength(2);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(JSON.stringify(stderr.mock.calls)).toContain("APNS_UNAVAILABLE");
    expect(JSON.stringify(stderr.mock.calls)).toContain(operationId);
    expect(JSON.stringify(stderr.mock.calls)).not.toMatch(/private Apple|management-secret/);
  } finally {
    stderr.mockRestore();
  }
});
