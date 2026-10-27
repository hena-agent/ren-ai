import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { randomUUID } from "node:crypto";
import { scheduleWork } from "../scheduling.ts";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";
import type { Metrics } from "@ren-ai/onboarding";

export const discordSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS application_alert (name TEXT PRIMARY KEY)`;
  yield* sql`ALTER TABLE application_alert ADD COLUMN raised_at INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE application_alert ADD COLUMN detail TEXT NOT NULL DEFAULT '운영 상태를 확인해 주세요.'`;
  yield* sql`ALTER TABLE application_alert ADD COLUMN url TEXT NOT NULL DEFAULT 'https://admin.renai.im/conversations'`;
  yield* sql`CREATE TABLE discord_delivery (channel TEXT PRIMARY KEY, state TEXT NOT NULL, cooldown INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`INSERT INTO discord_delivery(channel, state) VALUES ('alerts', 'unconfigured'), ('reports', 'unconfigured')`;
  yield* sql`CREATE TABLE discord_outbox (id TEXT PRIMARY KEY, channel TEXT NOT NULL, content TEXT NOT NULL, due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`CREATE INDEX discord_due ON discord_outbox(due, id)`;
  yield* sql`CREATE INDEX discord_channel_due ON discord_outbox(channel, due, id)`;
  yield* sql`CREATE TABLE metrics_report (id INTEGER PRIMARY KEY CHECK(id=1), due INTEGER NOT NULL)`;
  yield* sql`INSERT INTO metrics_report VALUES (1, CAST(unixepoch('now', '+9 hours', 'start of day') * 1000 AS INTEGER))`;
  yield* sql`INSERT INTO application_work(name, due) SELECT 'metrics-report', due FROM metrics_report`;
});

export const queueDiscord = (id: string, channel: "alerts" | "reports", content: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    yield* sql`INSERT INTO discord_outbox(id, channel, content, due) VALUES (${id}, ${channel}, ${content}, ${now})`;
    yield* sql`UPDATE discord_delivery SET pending = pending + 1 WHERE channel = ${channel}`;
    yield* scheduleWork("discord", now);
  });

const alertDescription = (name: string) => {
  if (name.startsWith("greeting:"))
    return {
      detail: "첫 인사에 실패했거나 전송 결과가 불확실합니다.",
      url: "https://admin.renai.im/first-contacts",
    };
  if (name === "joins-failing")
    return {
      detail: "최근 한 시간 동안 시스템 원인으로 등록이 3회 이상 실패했습니다.",
      url: "https://admin.renai.im/waitlist",
    };
  if (name === "notification-cap")
    return {
      detail: "시간당 30건 한도로 등록 안내를 생략했습니다.",
      url: "https://admin.renai.im/waitlist",
    };
  const details: Record<string, string> = {
    "disk-nearly-full": "실행 서버의 디스크 여유 공간이 부족합니다.",
    "screen-locked": "메시징 화면이 잠겨 있습니다.",
    "executor-unavailable": "대화 실행 서버에 연결할 수 없습니다.",
    "messaging-unavailable": "iMessage 연결 상태를 확인해 주세요.",
  };
  return {
    detail: details[name] ?? "대화 실행에 문제가 발생했습니다. 관리 화면에서 확인해 주세요.",
    url: "https://admin.renai.im/conversations",
  };
};

/** The caller owns the transaction so the state change and its message commit together. */
export const changeAlert = (name: string, raised: boolean) =>
  Effect.gen(function* () {
    if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(name)) return;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    const { detail, url } = alertDescription(name);
    const changed = raised
      ? yield* sql`INSERT OR IGNORE INTO application_alert(name, raised_at, detail, url) VALUES (${name}, ${now}, ${detail}, ${url}) RETURNING name`
      : yield* sql`DELETE FROM application_alert WHERE name = ${name} RETURNING name`;
    if (changed.length)
      yield* queueDiscord(
        randomUUID(),
        "alerts",
        `${raised ? "알림" : "해제"}: ${name}\n${detail}\n${url}`,
      );
  });

export type Webhooks = { alerts: string | undefined; reports: string | undefined };
export const configureDiscord = (webhooks: Webhooks) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const channel of ["alerts", "reports"] as const) {
      if (webhooks[channel])
        yield* sql`UPDATE discord_delivery SET state = 'accepting' WHERE channel = ${channel} AND state = 'unconfigured'`;
      else
        yield* sql`UPDATE discord_delivery SET state = 'unconfigured' WHERE channel = ${channel} AND state != 'unconfigured'`;
    }
  });
export const discordState = (webhooks: Webhooks) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      channel: "alerts" | "reports";
      state: "unconfigured" | "accepting" | "rejected";
      pending: number;
    }>`SELECT channel, state, pending FROM discord_delivery`;
    const state: {
      alerts: Metrics["delivery"]["alerts"];
      reports: Metrics["delivery"]["reports"];
    } = { alerts: "unconfigured", reports: "unconfigured" };
    for (const row of rows)
      state[row.channel] = webhooks[row.channel]
        ? row.state === "unconfigured"
          ? "accepting"
          : row.state
        : "unconfigured";
    return { ...state, pending: rows.reduce((total, row) => total + row.pending, 0) };
  });

const acceptDiscord = (id: string, channel: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.gen(function* () {
      const deleted = yield* sql`DELETE FROM discord_outbox WHERE id = ${id} RETURNING id`;
      if (deleted.length)
        yield* sql`UPDATE discord_delivery SET pending = pending - 1, state = 'accepting' WHERE channel = ${channel}`;
    }).pipe(sql.withTransaction);
  });

const scheduleDiscord = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`WITH next(due) AS (SELECT MIN(MAX(d.cooldown, (SELECT MIN(o.due) FROM discord_outbox o WHERE o.channel = d.channel))) FROM discord_delivery d)
    INSERT INTO application_work(name, due) SELECT 'discord', due FROM next WHERE due IS NOT NULL
    ON CONFLICT(name) DO UPDATE SET due = excluded.due, generation = generation + 1 WHERE due != excluded.due OR due <= ${now}`;
  yield* sql`DELETE FROM application_work WHERE name = 'discord' AND NOT EXISTS (SELECT 1 FROM discord_outbox)`;
});

export const deliverDiscord = (webhooks: Webhooks, fetcher: typeof fetch, requestId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    const channels = yield* sql<{
      channel: "alerts" | "reports";
    }>`SELECT channel FROM discord_delivery WHERE cooldown <= ${now}`;
    const candidates: {
      id: string;
      channel: "alerts" | "reports";
      content: string;
      attempts: number;
      due: number;
    }[] = [];
    for (const { channel } of channels)
      candidates.push(
        ...(yield* sql<
          (typeof candidates)[number]
        >`SELECT id, channel, content, attempts, due FROM discord_outbox WHERE channel = ${channel} AND due <= ${now} ORDER BY due, id LIMIT 4`),
      );
    const rows = candidates
      .toSorted((a, b) => a.due - b.due || a.id.localeCompare(b.id))
      .slice(0, 4);
    for (const row of rows) {
      const webhook = webhooks[row.channel];
      const due = now + Math.min(3_600_000, 30_000 * 2 ** Math.min(row.attempts, 7));
      const claimed =
        yield* sql`UPDATE discord_outbox SET due = ${due}, attempts = attempts + 1 WHERE id = ${row.id} AND due <= ${now} RETURNING id`;
      if (!claimed.length) continue;
      let state: "unconfigured" | "accepting" | "rejected" = webhook ? "rejected" : "unconfigured";
      const started = performance.now();
      let status: number | undefined;
      let globalLimit = false;
      const sent = yield* Effect.tryPromise(async (signal) => {
        if (!webhook)
          throw Object.assign(new Error("Discord unconfigured"), { code: "DISCORD_UNCONFIGURED" });
        const url = new URL(webhook);
        url.searchParams.set("wait", "true");
        const response = await fetcher(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: row.content, allowed_mentions: { parse: [] } }),
          signal,
          redirect: "manual",
        });
        status = response.status;
        const retry = response.headers.get("Retry-After");
        const rateLimit =
          response.status === 429
            ? await response
                .json()
                .then(
                  Schema.decodeUnknownSync(
                    Schema.Struct({
                      retry_after: Schema.optionalKey(Schema.Number),
                      global: Schema.optionalKey(Schema.Boolean),
                    }),
                  ),
                )
                .catch(() => ({ retry_after: 0, global: false }))
            : { retry_after: 0, global: false };
        globalLimit = rateLimit.global === true;
        await response.body?.cancel().catch(() => {});
        const seconds = Number(retry);
        if (response.status === 429)
          return {
            accepted: false,
            retry: Math.max(
              ...[
                due,
                retry && Number.isFinite(seconds)
                  ? now + seconds * 1000
                  : retry && Number.isFinite(Date.parse(retry))
                    ? Date.parse(retry)
                    : now,
                now + (rateLimit.retry_after ?? 0) * 1000,
              ].filter(Number.isFinite),
            ),
          };
        if (!response.ok)
          throw Object.assign(new Error("Discord rejected delivery"), {
            code: "DISCORD_HTTP",
            upstreamStatus: status,
          });
        return { accepted: true, retry: due };
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.catch((cause) => {
          contactLog({
            requestId,
            operation: "discord.delivery",
            stage: row.channel,
            outcome: "failed",
            durationMs: performance.now() - started,
            level: "error",
            ...(status && { upstreamStatus: status }),
            ...contactCause(cause),
          });
          return Effect.succeed({ accepted: false, retry: due });
        }),
      );
      if (status === 429)
        yield* Effect.gen(function* () {
          contactLog({
            requestId,
            operation: "discord.delivery",
            stage: row.channel,
            outcome: "failed",
            level: "warn",
            code: "DISCORD_RATE_LIMITED",
            upstreamStatus: 429,
            durationMs: performance.now() - started,
          });
          yield* sql`UPDATE discord_delivery SET cooldown = MAX(cooldown, ${sent.retry}) WHERE channel = ${row.channel} OR ${Number(globalLimit)}`;
        });
      if (sent.accepted) {
        state = "accepting";
        yield* acceptDiscord(row.id, row.channel);
      } else
        yield* sql`UPDATE discord_outbox SET due = ${sent.retry} WHERE id = ${row.id} AND due != ${sent.retry}`;
      yield* sql`UPDATE discord_delivery SET state = ${state} WHERE channel = ${row.channel} AND state != ${state}`;
      contactLog({
        requestId,
        operation: "discord.delivery",
        stage: "complete",
        outcome: sent.accepted ? "completed" : "failed",
        durationMs: performance.now() - started,
        level: "info",
        ...(status && { upstreamStatus: status }),
      });
      if (status === 429) break;
    }
    yield* scheduleDiscord;
  });
