import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, expect, test, vi } from "vitest";
import { discoveryNotice } from "@ren-ai/onboarding";
import { metricsFixture } from "../test/metrics-http.test-helper.ts";
import { captureDiagnostics } from "../test/diagnostics.test-helper.ts";
import { rewindMetrics } from "../test/rewind-metrics.test-helper.ts";
import { migrate } from "./database.ts";

afterEach(() => vi.restoreAllMocks());

test("the default network delivers the persisted Report with confirmation", async () => {
  const f = await metricsFixture(undefined, "test", "global");
  vi.spyOn(globalThis, "fetch").mockImplementation(f.fetcher);
  try {
    await f.alarm();
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(new Request(...f.fetcher.mock.calls[0]!).url).toBe(
      "https://discord.example/reports?wait=true&with_components=true",
    );
    expect((await f.read()).delivery.pending).toBe(0);
  } finally {
    await f.close();
  }
});

test("a partially drained Discord batch keeps an immediate alarm even when its deadline is unchanged", async () => {
  const f = await metricsFixture();
  try {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await f.alarm();
    await f.store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (let i = 0; i < 6; i++)
          yield* sql`INSERT INTO discord_outbox(id, channel, body, due) VALUES (${String(i)}, 'alerts', '{"content":"safe alert"}', ${now})`;
        yield* sql`UPDATE discord_delivery SET pending = 6 WHERE channel = 'alerts'`;
        yield* sql`INSERT INTO application_work(name, due) VALUES ('discord', ${now})`;
      }),
    );
    expect(await f.alarm()).toBe(now + 1);
    expect((await f.read()).delivery.pending).toBe(2);
    await f.alarm();
    expect((await f.read()).delivery.pending).toBe(0);
  } finally {
    await f.close();
  }
});

test("text queued before Discord cards is still delivered after the upgrade", async () => {
  const f = await metricsFixture();
  try {
    await f.alarm();
    await f.store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Recreate the deployed predecessor with one undelivered Alert.
        yield* sql`ALTER TABLE discord_outbox RENAME COLUMN body TO content`;
        yield* sql`ALTER TABLE discovery_registration DROP COLUMN hidden`;
        yield* sql`ALTER TABLE discovery_registration DROP COLUMN imessage_reason`;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 57`;
        yield* sql`INSERT INTO discord_outbox(id, channel, content, due) VALUES ('queued', 'alerts', '알림: disk-nearly-full', 0)`;
        yield* sql`UPDATE discord_delivery SET pending = 1 WHERE channel = 'alerts'`;
      }),
    );
    await f.store.run(migrate);
    await f.alarm();
    expect(await new Request(...f.fetcher.mock.lastCall!).json()).toEqual({
      content: "알림: disk-nearly-full",
      allowed_mentions: { parse: [] },
    });
    expect((await f.read()).delivery.pending).toBe(0);
  } finally {
    await f.close();
  }
});

test("staggered join failures retain their latest expiry after the earlier alarm completes", async () => {
  const f = await metricsFixture();
  try {
    const now = Date.now();
    f.catalog.mockRejectedValue(new Error("unavailable"));
    for (const minutes of [0, 20, 40]) {
      vi.spyOn(Date, "now").mockReturnValue(now + minutes * 60_000);
      expect((await f.register("+821012345678")).status).toBe(503);
    }
    expect((await f.read()).alerts).toHaveLength(1);
    await f.store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM discovery_attempt`;
        yield* sql`DELETE FROM discovery_verification`;
      }),
    );
    vi.spyOn(Date, "now").mockReturnValue(now + 60 * 60_000);
    await f.alarm();
    vi.spyOn(Date, "now").mockReturnValue(now + 99 * 60_000);
    expect(await f.alarm()).toBe(now + 100 * 60_000);
    vi.spyOn(Date, "now").mockReturnValue(now + 100 * 60_000);
    await f.alarm();
    expect((await f.read()).alerts).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a global Discord cooldown defers both destinations", async () => {
  const f = await metricsFixture();
  try {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    f.catalog.mockRejectedValue(new Error("unavailable"));
    for (let i = 0; i < 3; i++) await f.register("+821012345678");
    f.fetcher.mockResolvedValueOnce(
      Response.json({ global: true, retry_after: 120 }, { status: 429 }),
    );
    await f.alarm();
    vi.spyOn(Date, "now").mockReturnValue(now + 119_000);
    await f.alarm();
    expect(f.fetcher).toHaveBeenCalledOnce();
    vi.spyOn(Date, "now").mockReturnValue(now + 120_000);
    await f.alarm();
    expect((await f.read()).delivery.pending).toBe(0);
  } finally {
    await f.close();
  }
});

test("rollout counts future Selections for existing registrations and excludes new usage in existing test sessions", async () => {
  const f = await metricsFixture();
  try {
    await f.store.run(rewindMetrics);
    await f.store.run(
      f.directory.create({
        handle: "+821012345678",
        locale: "ko",
        consentVersion: discoveryNotice.version,
        consentLanguage: "ko",
        personaID: "test-persona",
        sessionID: "ses_existing",
      }),
    );
    await f.store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO test_handle(handle) VALUES ('+821012345678')`;
        yield* sql`INSERT INTO discovery_registration(id, handle, locale, consent_version, created_at, imessage_status, imessage_checked_at) VALUES ('old', '+821087654321', 'ko', 'old', 1, 'available', ${Date.now()})`;
        yield* sql`INSERT INTO discovery_like(registration_id, persona_id) VALUES ('old', 'sora')`;
      }),
    );
    await f.store.run(migrate);
    await f.store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO usage_entry(id, session_id, source, started_at, outcome, cost) VALUES ('post-rollout', 'ses_existing', 'message', ${Date.now()}, 'succeeded', 4)`;
      }),
    );
    const selected = await f.call("/management/discovery/select", {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), count: 1 }),
    });
    expect(selected.status).toBe(200);
    const metrics = await f.read();
    expect(metrics.totals).toEqual([expect.objectContaining({ step: "selection", count: 1 })]);
    expect(metrics.cost).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a failed Metrics write preserves the original join response and diagnoses storage without payloads", async () => {
  const f = await metricsFixture();
  const diagnostics = captureDiagnostics();
  try {
    await f.store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER fail_metric BEFORE INSERT ON metric_total BEGIN SELECT RAISE(FAIL, 'private-storage-payload'); END`;
      }),
    );
    const response = await f.register("+821012345678", { privacyNoticeVersion: "old" });
    expect(response.status).toBe(400);
    const logs = diagnostics.logs.join("\n");
    expect(logs).toContain(response.headers.get("X-Request-ID"));
    expect(logs).toContain('"stage":"failure.count"');
    expect(logs).toContain('"causeName"');
    expect(logs).not.toMatch(/private-storage-payload|821012345678|private-name/);
  } finally {
    diagnostics.restore();
    await f.close();
  }
});

test("a secondary activity read failure is correlated and missing management credentials fail closed", async () => {
  const f = await metricsFixture();
  try {
    f.activity.mockImplementation(async (request) =>
      new URL(request.url).searchParams.get("breakdown") === "total"
        ? new Response(null, { status: 503 })
        : f.browser(request),
    );
    const response = await f.call(
      `/management/metrics?from=${f.day}&to=${f.day}&breakdown=country`,
      { headers: { Authorization: "Bearer test" } },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      requestId: response.headers.get("X-Request-ID"),
    });
  } finally {
    await f.close();
  }
  const missing = await metricsFixture(undefined, "");
  try {
    expect((await missing.call("/management/metrics")).status).toBe(401);
  } finally {
    await missing.close();
  }
});

test("concurrent Discord retry claims and a late duplicate confirmation never lose or double-decrement pending work", async () => {
  const f = await metricsFixture();
  let accepted!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    accepted = resolve;
  });
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  try {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    f.catalog.mockRejectedValue(new Error("unavailable"));
    for (let index = 0; index < 3; index++) await f.register("+821012345678");
    f.fetcher.mockImplementationOnce(() => {
      began();
      return pending;
    });
    const first = f.store.metricsTick("first-attempt");
    await started;
    vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
    await Promise.all(Array.from({ length: 8 }, (_, i) => f.store.metricsTick(`retry-${i}`)));
    expect((await f.read()).delivery.pending).toBe(0);
    accepted(Response.json({ id: "late-acceptance" }));
    await first;
    expect((await f.read()).delivery.pending).toBe(0);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  } finally {
    accepted(Response.json({ id: "cleanup" }));
    await f.close();
  }
});

test.each([{}, { retry_after: 1e308 }])(
  "a malformed Discord cooldown %j keeps a finite retry schedule",
  async (body) => {
    const f = await metricsFixture();
    try {
      f.fetcher.mockResolvedValueOnce(Response.json(body, { status: 429 }));
      await f.store.metricsTick("malformed-cooldown");
      expect((await f.read()).delivery.pending).toBe(1);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
      await f.store.metricsTick("retry-malformed");
      expect((await f.read()).delivery.pending).toBe(0);
    } finally {
      await f.close();
    }
  },
);

test("Report failure backoff survives intervening ticks and Alert delivery", async () => {
  const f = await metricsFixture();
  try {
    f.activity.mockResolvedValue(new Response(null, { status: 503 }));
    await f.store.metricsTick("report-fails");
    const reads = f.activity.mock.calls.length;
    await f.store.metricsTick("report-idle");
    expect(f.activity).toHaveBeenCalledTimes(reads);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    f.activity.mockImplementation(f.browser);
    await f.store.metricsTick("report-recovered");
    expect(f.fetcher).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

test.each(["photo", "recorded-text"])(
  "restored %s sends cannot become a Greeting",
  async (kind) => {
    const f = await metricsFixture();
    try {
      const conversation = await f.startConversation("ses_restored");
      await f.store.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const now = Date.now();
          if (kind === "recorded-text")
            yield* sql`INSERT INTO send(handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at) VALUES (${conversation.handle}, ${conversation.id}, 'text', 'private', 'unfinished', 'recorded', ${now}, ${now})`;
          yield* sql`INSERT INTO send(handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at) VALUES (${conversation.handle}, ${conversation.id}, 'photo', 'private', 'photo', 'recorded', ${now}, ${now})`;
        }),
      );
      expect((await f.release("photo")).status).toBe(200);
      expect((await f.read()).totals.some((row) => row.step.startsWith("greeting"))).toBe(false);
      expect((await f.read()).alerts).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

test("removal clears a restored Greeting Alert without changing anonymous totals", async () => {
  const f = await metricsFixture();
  try {
    await f.register("+821012345678");
    await f.store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO application_alert(name, raised_at) SELECT 'greeting:' || id, ${Date.now()} FROM discovery_registration`;
      }),
    );
    const before = await f.read();
    expect(before.alerts).toHaveLength(1);
    const response = await f.call("/operator/remove", {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "+821012345678" }),
    });
    expect(response.status).toBe(200);
    const after = await f.read();
    expect(after.alerts).toEqual([]);
    expect(after.totals).toEqual(before.totals);
  } finally {
    await f.close();
  }
});

test("a pre-rollout Greeting cannot turn a later ordinary send into a new Greeting cohort", async () => {
  const f = await metricsFixture();
  try {
    const conversation = await f.startConversation("ses_existing_greeting");
    await f.store.run(rewindMetrics);
    await f.store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO send(handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at) VALUES (${conversation.handle}, ${conversation.id}, 'text', 'private', 'old', 'sent', 1, 1)`;
      }),
    );
    await f.store.run(migrate);
    await f.store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO send(handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at) VALUES (${conversation.handle}, ${conversation.id}, 'text', 'private', 'new', 'recorded', ${Date.now()}, ${Date.now()})`;
      }),
    );
    const response = await f.release("new", "delivered");
    expect(response.status).toBe(200);
    expect((await f.read()).totals).toEqual([]);
    expect((await f.read()).alerts).toEqual([]);
  } finally {
    await f.close();
  }
});

test("resolving a photo does not clear or suppress a failed text Greeting", async () => {
  const f = await metricsFixture();
  try {
    const conversation = await f.startConversation("ses_photo");
    await f.store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [kind, state] of [
          ["text", "failed"],
          ["photo", "recorded"],
        ])
          yield* sql`INSERT INTO send(handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at) VALUES (${conversation.handle}, ${conversation.id}, ${kind}, 'private', ${kind}, ${state}, ${Date.now()}, ${Date.now()})`;
      }),
    );
    const response = await f.release("photo");
    expect(response.status).toBe(200);
    expect((await f.read()).totals).toContainEqual(
      expect.objectContaining({ step: "greeting_failed", count: 1 }),
    );
    expect((await f.read()).alerts).toHaveLength(1);
  } finally {
    await f.close();
  }
});
