import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { CloudflareConfiguration } from "./cloudflare-config.ts";
import { contactCause, contactLog } from "./discovery/diagnostics.ts";
import { randomUUID } from "node:crypto";
import { parseHealth } from "@ren-ai/transport/health";

const Facts = Schema.Struct({ diskNearlyFull: Schema.Boolean, screenLocked: Schema.Boolean });

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow health and notification failures into payload-free diagnostics
const diagnose = (cause: unknown, stage: string) => {
  const root = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause;
  contactLog({
    requestId: randomUUID(),
    operation: "api-app.health",
    stage,
    outcome: "failed",
    durationMs: 0,
    level: "error",
    ...contactCause(root),
    ...(root instanceof Error &&
      "status" in root &&
      typeof root.status === "number" && { status: root.status }),
  });
};

const notify = (text: string, webhook: string | undefined, fetcher: typeof fetch) =>
  Effect.tryPromise(async () => {
    if (!webhook) return;
    const response = await fetcher(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
    if (!response.ok)
      throw Object.assign(new Error("Alert delivery failed"), {
        status: response.status,
        code: "ALERT_HTTP",
      });
  }).pipe(Effect.catch((cause) => Effect.sync(() => diagnose(cause, "alert.delivery"))));

export const createExecutionHealth = (
  configuration: CloudflareConfiguration["execution"],
  webhook: string | undefined,
  fetcher: typeof fetch,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS application_alert (name TEXT PRIMARY KEY)`;
    const raise = (name: string, _detail?: string) =>
      Effect.gen(function* () {
        if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(name)) return;
        const changed =
          yield* sql`INSERT OR IGNORE INTO application_alert (name) VALUES (${name}) RETURNING name`;
        if (changed.length) yield* notify(`Alert: ${name}`, webhook, fetcher);
      }).pipe(Effect.orDie);
    const clear = (name: string) =>
      Effect.gen(function* () {
        const changed =
          yield* sql`DELETE FROM application_alert WHERE name = ${name} RETURNING name`;
        if (changed.length) yield* notify(`Cleared: ${name}`, webhook, fetcher);
      }).pipe(Effect.orDie);
    let nextCheck = 0;
    const tick = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (now < nextCheck) return;
      nextCheck = now + 60_000;
      const check = Effect.tryPromise(async () => {
        const response = await fetcher(new URL("/health", configuration.apiMsgUrl), {
          headers: { Authorization: `Bearer ${configuration.managementToken}` },
          signal: AbortSignal.timeout(10_000),
          redirect: "manual",
        });
        if (response.status !== 200 && response.status !== 503)
          throw Object.assign(new Error("Executor health is unavailable"), {
            status: response.status,
            code: "EXECUTOR_HEALTH_HTTP",
          });
        try {
          const body = await response.json();
          const health = parseHealth(body, "api-msg");
          if (response.status !== (health.status === "ready" ? 200 : 503))
            throw new Error("Executor health status is inconsistent");
          return Schema.decodeUnknownSync(Facts)(body);
        } catch (cause) {
          throw Object.assign(new Error("Invalid executor health response", { cause }), {
            status: response.status,
            code: "EXECUTOR_HEALTH_INVALID",
          });
        }
      }).pipe(
        Effect.flatMap((facts) =>
          Effect.all([
            facts.diskNearlyFull ? raise("disk-nearly-full") : clear("disk-nearly-full"),
            facts.screenLocked ? raise("screen-locked") : clear("screen-locked"),
            clear("executor-unavailable"),
          ]),
        ),
        Effect.catch((cause) =>
          Effect.sync(() => diagnose(cause, "executor.health")).pipe(
            Effect.andThen(raise("executor-unavailable")),
          ),
        ),
      );
      yield* check;
    });
    return { raise, clear, tick };
  });
