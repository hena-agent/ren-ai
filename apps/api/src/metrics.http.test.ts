import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, expect, test, vi } from "vitest";
import { MetricTotal, discoveryNotice } from "@ren-ai/onboarding";
import { captureDiagnostics } from "../test/diagnostics.test-helper.ts";
import { metricsFixture as fixture } from "../test/metrics-http.test-helper.ts";
import { waitlistNotifications } from "./discovery/notifications.ts";
import { fakeMessages } from "@ren-ai/imsg/testing";

afterEach(() => vi.restoreAllMocks());

const source = {
  entry: "home",
  referrer: "example.org",
  source: "friends",
  medium: "social",
  campaign: "launch",
};
const report = { step: "visit", source, device: "phone", locale: "ko", imageStyle: "anime" };
const request = (body: object | string, country = "KR") =>
  new Request("https://activity.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-IPCountry": country },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("activity intake, registration attribution and range reads reject invalid inputs without leaking private data", async () => {
  const f = await fixture();
  const diagnostics = captureDiagnostics();
  try {
    expect((await f.call(`/management/metrics?from=${f.day}&to=${f.day}`)).status).toBe(401);
    expect(
      (
        await f.call("/management/metrics", {
          method: "POST",
          headers: { Authorization: "Bearer test" },
        })
      ).status,
    ).toBe(405);
    const invalid = await f.call("/management/metrics?from=private-name&to=2026-01-01", {
      headers: { Authorization: "Bearer test" },
    });
    expect(invalid.status).toBe(400);
    expect((await f.browser(request("x".repeat(2049)))).status).toBe(413);
    expect((await f.browser(request({ ...report, handle: "private-handle" }))).status).toBe(400);
    const visit = await f.browser(request(report));
    expect(visit.status).toBe(204);
    expect(visit.headers.get("X-Visit-Country")).toBe("KR");
    expect(
      (
        await f.browser(
          request({ ...report, step: "like", persona: "sora", visitCountry: "KR" }, "US"),
        )
      ).status,
    ).toBe(204);
    expect((await f.register("+821012345678", { source, visitCountry: "KR" })).status).toBe(200);
    expect((await f.register("+821012345678", { source })).status).toBe(200);
    const country = await f.read("country");
    expect(country.totals.filter((row) => row.dimension === "country")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step: "visit", value: "KR", count: 1 }),
        expect.objectContaining({ step: "join", value: "KR", count: 1 }),
        expect.objectContaining({ step: "like", value: "KR", count: 1 }),
      ]),
    );
    const personas = await f.read("persona");
    expect(personas.personas).toEqual(
      expect.arrayContaining([expect.objectContaining({ step: "join", value: "sora", count: 1 })]),
    );
    expect((await f.read()).totals.filter((row) => row.step === "join")).toEqual([
      expect.objectContaining({ count: 1 }),
    ]);
    const log = diagnostics.logs.join("\n");
    expect(log).toContain(invalid.headers.get("X-Request-ID"));
    expect(log).toContain("range.validate");
    expect(log).toContain("activity.validate");
    expect(log).not.toMatch(/private-name|private-handle|821012345678/);
  } finally {
    diagnostics.restore();
    await f.close();
  }
});

test("Metrics read failures remain correlated and a failed Report cannot prevent a later retry", async () => {
  const f = await fixture();
  const diagnostics = captureDiagnostics();
  try {
    f.activity.mockResolvedValue(new Response(null, { status: 503 }));
    const failed = await f.call(`/management/metrics?from=${f.day}&to=${f.day}`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ requestId: failed.headers.get("X-Request-ID") });
    await f.store.metricsTick("report-failure");
    expect(f.fetcher).not.toHaveBeenCalled();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    f.activity.mockImplementation(f.browser);
    f.fetcher.mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
    );
    await f.store.metricsTick("report-retry");
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect((await f.read()).delivery).toEqual({
      alerts: "accepting",
      reports: "rejected",
      pending: 1,
    });
    await f.store.metricsTick("report-cooldown");
    expect(f.fetcher).toHaveBeenCalledOnce();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 120_000);
    await f.store.metricsTick("report-accepted");
    expect((await f.read()).delivery).toEqual({
      alerts: "accepting",
      reports: "accepting",
      pending: 0,
    });
    const body = await new Request(...f.fetcher.mock.calls[1]!).text();
    expect(body).toContain("방문: 0 / 0");
    expect(body).toContain("30일 유지");
    expect(body).toContain("종료·운영자");
    const logs = diagnostics.logs.join("\n");
    expect(logs).toContain("report-failure");
    expect(logs).toContain("DISCORD_RATE_LIMITED");
    expect(logs).not.toContain("discord.example");
  } finally {
    diagnostics.restore();
    await f.close();
  }
});

test("activity cardinality is bounded across arbitrary steps without sacrificing totals", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 258; index++)
      expect(
        (
          await f.browser(
            request({
              ...report,
              step: "like",
              source: { ...source, campaign: String(index) },
              persona: `p${index}`,
            }),
          )
        ).status,
      ).toBe(204);
    const response = await f.browser(
      new Request(`https://activity.test/?from=${f.day}&to=${f.day}&breakdown=source`),
    );
    const rows = Schema.decodeUnknownSync(Schema.Array(MetricTotal))(await response.json());
    expect(rows).toHaveLength(257);
    expect(rows.find((row) => row.value === "other")?.count).toBe(2);
    expect((await f.read()).totals).toEqual([
      expect.objectContaining({ step: "like", count: 258 }),
    ]);
  } finally {
    await f.close();
  }
});

test("system join failures raise a safe Alert even for test handles and clear after an hour without a failure", async () => {
  const f = await fixture();
  const diagnostics = captureDiagnostics();
  try {
    expect((await f.mark(true)).status).toBe(200);
    f.catalog.mockRejectedValue(new Error("private-name private-upstream"));
    for (let index = 0; index < 3; index++)
      expect((await f.register("+821012345678")).status).toBe(503);
    const raised = await f.read();
    expect(raised.totals).toEqual([]);
    expect(raised.alerts).toEqual([
      expect.objectContaining({ name: "joins-failing", url: "https://admin.renai.im/waitlist" }),
    ]);
    await f.store.metricsTick("join-alert-delivery");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 3_600_001);
    await f.store.metricsTick("join-alert-clear");
    expect((await f.read()).alerts).toEqual([]);
    expect(JSON.stringify(f.fetcher.mock.calls)).toContain("joins-failing");
    expect(JSON.stringify(f.fetcher.mock.calls)).not.toMatch(
      /821012345678|private-name|private-upstream/,
    );
    expect(diagnostics.logs.join("\n")).not.toMatch(/821012345678|private-name|private-upstream/);
  } finally {
    diagnostics.restore();
    await f.close();
  }
});

test("marking removes cost history, unmarking counts only new entries, and removal retains that cost", async () => {
  const f = await fixture();
  try {
    expect((await f.register("+821012345678", { source })).status).toBe(200);
    await f.store.run(
      f.directory.create({
        handle: "+821012345678",
        locale: "ko",
        consentVersion: discoveryNotice.version,
        consentLanguage: "ko",
        personaID: "sora",
        sessionID: "ses_cost",
      }),
    );
    const now = Date.now();
    const usage = (id: string, at: number, cost: number) =>
      f.store.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO usage_entry(id, session_id, source, started_at, outcome, cost) VALUES (${id}, 'ses_cost', 'message', ${at}, 'succeeded', ${cost})`;
        }),
      );
    await usage("before", now, 1);
    expect((await f.read()).cost).toEqual([expect.objectContaining({ cost: 1, conversations: 1 })]);
    expect((await f.mark(true)).status).toBe(200);
    await usage("test", now + 1, 2);
    expect((await f.read()).cost).toEqual([]);
    const unmarked = Date.now();
    expect((await f.mark(false)).status).toBe(200);
    await usage("late", now, 3);
    await usage("after", unmarked + 1000, 4);
    expect((await f.read()).cost).toEqual([expect.objectContaining({ cost: 4, conversations: 1 })]);
    const removed = await f.call("/operator/remove", {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "+821012345678" }),
    });
    expect(removed.status).toBe(200);
    expect((await f.read()).cost).toEqual([expect.objectContaining({ cost: 4, conversations: 1 })]);
  } finally {
    await f.close();
  }
});

test("a nonempty Report compares periods and retains its link and Retention in one Discord message", async () => {
  const f = await fixture();
  try {
    await f.browser(request(report));
    await f.browser(request(report));
    await f.browser(request({ ...report, source: { ...source, campaign: "second" } }));
    await f.register("+821012345678", { source });
    await f.store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO usage_session(session_id, conversation_id, conversation_key, persona_id) VALUES ('historical', 0, 'anonymous', 'sora')`;
        yield* sql`INSERT INTO usage_entry(id, session_id, source, started_at, outcome, cost) VALUES ('historical', 'historical', 'message', ${Date.now()}, 'succeeded', 1)`;
        yield* sql`INSERT INTO metric_total(day, step, dimension, value, count) VALUES (${f.day}, 'ending', 'initiator', 'operator', 1)`;
      }),
    );
    await f.store.metricsTick("first-report");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 86_400_000);
    await Promise.all([f.store.metricsTick("next-report-a"), f.store.metricsTick("next-report-b")]);
    const contents = await Promise.all(
      f.fetcher.mock.calls.map(
        async ([input, init]) =>
          Schema.decodeUnknownSync(Schema.Struct({ content: Schema.String }))(
            await new Request(input, init).json(),
          ).content,
      ),
    );
    expect(contents).toHaveLength(2);
    const content = contents[1]!;
    expect(content).toContain("방문: 3 / 0");
    expect(content).toContain("등록: 1 / 0");
    expect(content).toContain("33.3%");
    expect(content).toContain("둘러보기");
    expect(content).toContain("friends");
    expect(content).toContain("https://admin.renai.im/metrics");
    expect(content.length).toBeLessThanOrEqual(2000);
  } finally {
    await f.close();
  }
});

test("Notification cap Alerts raise on a skipped delivery and clear when the hour has room", async () => {
  const f = await fixture();
  const fake = fakeMessages();
  try {
    for (let index = 0; index < 31; index++)
      expect((await f.register(`+8210${10000000 + index}`)).status).toBe(200);
    const notifications = await f.store.run(
      waitlistNotifications({
        notify: fake.messages.notify,
        notificationStatus: fake.messages.notificationStatus,
        availability: (handle) =>
          fake.messages
            .availability(handle)
            .pipe(Effect.map((result) => ({ ...result, requestId: crypto.randomUUID() }))),
      }),
    );
    await f.store.run(notifications.tick);
    await f.store.run(notifications.tick);
    expect((await f.read()).alerts).toEqual([
      expect.objectContaining({ name: "notification-cap" }),
    ]);
    await f.store.metricsTick("notification-cap");
    expect((await f.read()).alerts).toHaveLength(1);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 3_600_001);
    await f.store.metricsTick("notification-cap-clear");
    expect((await f.read()).alerts).toEqual([]);
    expect(JSON.stringify(f.fetcher.mock.calls)).not.toMatch(/821010000000|private-name/);
  } finally {
    await f.close();
  }
});

test("missing Discord configuration stays visible and retains the Report for later delivery", async () => {
  const f = await fixture({ alerts: undefined, reports: undefined });
  const diagnostics = captureDiagnostics();
  try {
    await f.store.metricsTick("missing-discord");
    expect((await f.read()).delivery).toEqual({
      alerts: "unconfigured",
      reports: "unconfigured",
      pending: 1,
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(diagnostics.logs.join("\n")).toContain("DISCORD_UNCONFIGURED");
  } finally {
    diagnostics.restore();
    await f.close();
  }
});

test.each(["json", "date", "invalid-header", "invalid-body"])(
  "Discord %s rate-limit responses defer the entire channel",
  async (kind) => {
    const f = await fixture();
    try {
      const now = Date.now();
      const retryAfter =
        kind === "date"
          ? new Date(now + 120_000).toUTCString()
          : kind === "invalid-header"
            ? "invalid"
            : "120";
      f.fetcher.mockResolvedValueOnce(
        new Response(kind === "invalid-body" ? "invalid" : JSON.stringify({ retry_after: 120 }), {
          status: 429,
          headers: kind === "json" ? {} : { "Retry-After": retryAfter },
        }),
      );
      await f.store.metricsTick("limited");
      vi.spyOn(Date, "now").mockReturnValue(now + 119_000);
      await f.store.metricsTick("cooldown");
      expect(f.fetcher).toHaveBeenCalledOnce();
      vi.spyOn(Date, "now").mockReturnValue(now + 121_000);
      await f.store.metricsTick("accepted");
      expect((await f.read()).delivery.pending).toBe(0);
      expect(f.fetcher).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
  },
);
